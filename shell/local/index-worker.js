'use strict';

const os = require('node:os');
const path = require('node:path');
const { parentPort, workerData, Worker } = require('node:worker_threads');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const { readGames } = require('./pgn-stream');
const { keyOf } = require('./replay');
const { countTree } = require('./tree-count');
const { unpacked } = require('./asar');

const PROGRESS_EVERY = 2_000;

const BATCH = 500;

const CORES = os.availableParallelism?.() ?? os.cpus().length;
const REPLAYERS = Math.max(1, Math.min(16, CORES > 2 ? CORES - 1 : CORES));

const COUNTERS = Number(process.env.INDEX_COUNTERS ?? Math.max(0, Math.min(6, CORES - 2)));

const TREE_ROWS = 32;

const BUCKETS = 256;

const LAYOUT = 4;

const MIGRATE_CHUNK = 500_000;

const hex = (bucket) => bucket.toString(16).padStart(2, '0');
const heapOf = (bucket) => `posh_${hex(bucket)}`;
const positionsOf = (bucket) => `pos_${hex(bucket)}`;
const treeOf = (bucket) => `tree_${hex(bucket)}`;

const SCHEMA = `
/**
 * The files this database is built from, in the order they were added.
 *
 * One database used to be one file. Then a weekly PGN arrived and the only way to take it in was to
 * merge the files by hand and index the whole thing again from nothing - so a database is a list of
 * files now, and adding one reads only that one.
 */
CREATE TABLE source (
	id INTEGER PRIMARY KEY,
	path TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	/**
	 * How far into this file the index has got, in bytes, and whether it got to the end.
	 *
	 * Written in the same transaction as the games it accounts for, which is what makes an index
	 * resumable: whatever is in the file is exactly what readTo says is in it, so a run that was
	 * cut short - the application closed, the machine shut down - is continued by opening the file
	 * again at that offset. A megabase is hours of work, and starting those hours again because a
	 * laptop lid was closed is not a thing to ask of anybody.
	 */
	readTo INTEGER NOT NULL DEFAULT 0,
	done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE game (
	id INTEGER PRIMARY KEY,
	sourceId INTEGER NOT NULL,
	white TEXT NOT NULL,
	whiteElo INTEGER,
	black TEXT NOT NULL,
	blackElo INTEGER,
	result TEXT NOT NULL,
	date TEXT,
	year INTEGER,
	/** The date as an ISO day when the PGN gave a whole one, null when it gave "2026.??.??". */
	playedOn TEXT,
	event TEXT,
	site TEXT,
	round TEXT,
	eco TEXT,
	strength INTEGER,
	plyCount INTEGER NOT NULL,
	/**
	 * The folded, order-independent form of each name, so a player can be found by identity rather
	 * than by spelling. Computed exactly as the server computes it, because the keys a search is
	 * given come from the server's own player table and the two have to meet.
	 */
	whiteKey TEXT NOT NULL,
	blackKey TEXT NOT NULL,
	start INTEGER NOT NULL,
	length INTEGER NOT NULL
);

/**
 * The distinct moves this file contains, as (SAN, UCI) pairs.
 *
 * SAN is written per position - "Nf3" here, "Nbd2" there - so the pair is the unit, not the string.
 * There are a few tens of thousands of distinct pairs in any archive and tens of millions of
 * positions, so naming each one once and pointing at it is the difference between an index that
 * fits on the disk and one that does not.
 */
CREATE TABLE move (
	id INTEGER PRIMARY KEY,
	san TEXT NOT NULL,
	uci TEXT NOT NULL
);

/** How many positions each counted bucket holds, so the total is a sum and not a scan. */
CREATE TABLE bucket (
	id INTEGER PRIMARY KEY,
	positions INTEGER NOT NULL
);
`;

const heapTable = (bucket) =>
	`CREATE TABLE IF NOT EXISTS ${heapOf(bucket)} (key BLOB NOT NULL, gameId INTEGER NOT NULL, ply INTEGER NOT NULL, moveId INTEGER NOT NULL)`;

const positionTable = (name) =>
	`CREATE TABLE ${name} (key BLOB NOT NULL, gameId INTEGER NOT NULL, ply INTEGER NOT NULL, moveId INTEGER NOT NULL,
	 PRIMARY KEY (key, gameId, ply)) WITHOUT ROWID`;

const treeTable = (name) =>
	`CREATE TABLE ${name} (key BLOB NOT NULL, moveId INTEGER NOT NULL, games INTEGER NOT NULL,
	 whiteWins INTEGER NOT NULL, draws INTEGER NOT NULL, blackWins INTEGER NOT NULL, topGameId INTEGER,
	 PRIMARY KEY (key, moveId)) WITHOUT ROWID`;

const GAME_INDEXES = [
	['game_white_key', 'game (whiteKey)'],
	['game_black_key', 'game (blackKey)'],
	['game_played', 'game (playedOn, year)'],
];

function log(text) {
	parentPort?.postMessage({ type: 'log', text });
	if (!parentPort && process.env.INDEX_DEBUG) console.log(text);
}

function report(stage, done, total) {
	parentPort?.postMessage({ type: 'progress', stage, done, total });
}

async function build({ sources, index, maxPly, restart = false }) {
	if (restart) {
		log('worker: index deleted, reading every file again');
		fs.rmSync(index, { force: true });
		fs.rmSync(`${index}-wal`, { force: true });
		fs.rmSync(`${index}-shm`, { force: true });
	}

	const db = new DatabaseSync(index);
	const fresh = db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n === 0;

	if (fresh) {
		db.exec('PRAGMA page_size = 16384');
	}

	// WAL, not off: an interrupted transaction must corrupt nothing, or there is nothing to resume from.
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = NORMAL');
	db.exec('PRAGMA cache_size = -131072');
	db.exec('PRAGMA temp_store = FILE');
	db.exec(`PRAGMA threads = ${Math.min(8, CORES)}`);

	if (fresh) {
		log('worker: new, empty index');
		db.exec(SCHEMA);
		db.exec(`PRAGMA user_version = ${LAYOUT}`);
	}

	try {
		const oldLayout = hasTable(db, 'position');
		const budget = new Budget();

		const addSource = db.prepare('INSERT INTO source (id, path, bytes, readTo, done) VALUES (?, ?, ?, 0, 0)');
		const markSource = db.prepare('UPDATE source SET readTo = ?, done = ? WHERE id = ?');
		const resetSource = db.prepare('UPDATE source SET path = ?, bytes = ?, readTo = 0, done = 0 WHERE id = ?');

		const known = new Map();
		if (!fresh) {
			for (const row of db.prepare('SELECT id, path, bytes, readTo, done FROM source').all()) {
				known.set(row.id, row);
			}
		}

		const pending = [];
		const replaced = [];
		for (let at = 0; at < sources.length; at++) {
			const id = at + 1;
			const source = sources[at];
			const row = known.get(id);

			if (!row) {
				addSource.run(id, source.path, source.bytes);
				pending.push({ id, path: source.path, bytes: source.bytes, readTo: 0 });
				continue;
			}
			// A different size than what was indexed is not the same file; re-read it from the start.
			if (row.path !== source.path || row.bytes !== source.bytes) {
				log(
					`worker: file ${id} is not the one indexed (${row.bytes} bytes then, ${source.bytes} now) - reading it again`,
				);
				replaced.push(id);
				resetSource.run(source.path, source.bytes, id);
				pending.push({ id, path: source.path, bytes: source.bytes, readTo: 0 });
				continue;
			}
			if (row.done) {
				continue;
			}
			pending.push({ id, path: source.path, bytes: source.bytes, readTo: row.readTo });
		}

		if (oldLayout) {
			migrate(db);
		}

		for (const id of replaced) {
			forgetSource(db, id);
		}

		if (pending.length > 0) {
			for (let bucket = 0; bucket < BUCKETS; bucket++) {
				db.exec(heapTable(bucket));
			}
			for (const [name] of GAME_INDEXES) {
				db.exec(`DROP INDEX IF EXISTS ${name}`);
			}
		}
		for (const source of pending) {
			log(`worker: file ${source.id} from byte ${source.readTo} of ${source.bytes}, ${REPLAYERS} replay workers`);
		}

		if (pending.length > 0) {
			await read(db, pending, maxPly, markSource);
		}

		await count(db, budget, index);

		db.exec('PRAGMA optimize');
		const games = db.prepare('SELECT COUNT(*) AS n FROM game').get().n;
		const positions = db.prepare('SELECT COALESCE(SUM(positions), 0) AS n FROM bucket').get().n;
		db.close();
		return { games, positions, indexedSources: sources.length };
	} catch (error) {
		// A failed COMMIT (e.g. disk full) already ends the transaction; ROLLBACK then fails and would hide this error.
		try {
			if (db.isTransaction) db.exec('ROLLBACK');
		} catch {
			// Nothing to roll back.
		}
		try {
			db.close();
		} catch {
			// Already closed.
		}
		throw error;
	}
}

async function read(db, pending, maxPly, markSource) {
	const addGame = db.prepare(
		`INSERT INTO game (id, sourceId, white, whiteElo, black, blackElo, result, date, year, playedOn, event, site,
		                   round, eco, strength, plyCount, whiteKey, blackKey, start, length)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const addMove = db.prepare('INSERT INTO move (id, san, uci) VALUES (?, ?, ?)');
	const heaps = new Appender(db);

	const moves = new Map();
	for (const row of db.prepare('SELECT id, san, uci FROM move').all()) {
		moves.set(`${row.san} ${row.uci}`, row.id);
	}
	let nextMoveId = moves.size + 1;

	const moveId = (san, uci) => {
		const pair = `${san} ${uci}`;
		const seen = moves.get(pair);
		if (seen !== undefined) return seen;
		const id = nextMoveId++;
		moves.set(pair, id);
		addMove.run(id, san, uci);
		return id;
	};

	let games = db.prepare('SELECT MAX(id) AS top FROM game').get().top ?? 0;
	let since = 0;

	const total = pending.reduce((sum, source) => sum + source.bytes, 0);
	let ahead = pending.reduce((sum, source) => sum + source.readTo, 0);

	const pool = new ReplayPool(REPLAYERS, maxPly);
	const queued = [];
	const limit = REPLAYERS * 2;

	const write = (source, base, batch, replayed) => {
		const { plies, counts, keys, sans, ucis } = replayed;
		let position = 0;

		for (let at = 0; at < batch.length; at++) {
			const game = batch[at];
			const tags = game.tags;
			games++;

			const whiteElo = number(tags.WhiteElo);
			const blackElo = number(tags.BlackElo);
			const white = tags.White ?? '?';
			const black = tags.Black ?? '?';

			addGame.run(
				games,
				source.id,
				white,
				whiteElo,
				black,
				blackElo,
				tags.Result ?? '*',
				tags.Date ?? null,
				year(tags.Date),
				playedOn(tags.Date),
				tags.Event ?? null,
				tags.Site ?? null,
				tags.Round ?? null,
				tags.ECO ?? null,
				strength(whiteElo, blackElo),
				plies[at],
				nameKey(white),
				nameKey(black),
				game.offset,
				game.length,
			);

			for (let ply = 0; ply < counts[at]; ply++, position++) {
				const offset = position * 12;
				heaps.add(keys.subarray(offset, offset + 12), games, ply, moveId(sans[position], ucis[position]));
			}

			if (++since % PROGRESS_EVERY === 0) {
				// The offset and the games it accounts for are committed together, or not at all.
				const mark = game.offset + game.length;
				heaps.flush();
				markSource.run(mark, 0, source.id);
				db.exec('COMMIT');
				db.exec('BEGIN');
				report('reading', base + mark, total);
			}
		}
	};

	const send = (source, base, batch) => {
		const replayed = pool.replay(batch.map((game) => ({ moves: game.moves, fen: game.tags.FEN ?? null })));
		replayed.catch(() => {
			// Failures are handled where the result is awaited.
		});
		queued.push({ source, base, batch, replayed });
	};

	// Batches replay concurrently but are written back strictly in read order, so ids and offsets stay reproducible.
	const writeOldest = async () => {
		const { source, base, batch, replayed } = queued.shift();
		write(source, base, batch, await replayed);
	};

	const started = Date.now();
	db.exec('BEGIN');
	try {
		for (const source of pending) {
			const base = ahead - source.readTo;
			let batch = [];

			for await (const game of readGames(source.path, source.readTo)) {
				batch.push(game);
				if (batch.length === BATCH) {
					send(source, base, batch);
					batch = [];
					while (queued.length >= limit) {
						await writeOldest();
					}
				}
			}
			if (batch.length > 0) {
				send(source, base, batch);
			}
			while (queued.length > 0) {
				await writeOldest();
			}

			heaps.flush();
			markSource.run(source.bytes, 1, source.id);
			db.exec('COMMIT');
			db.exec('BEGIN');
			ahead = base + source.bytes;
			report('reading', ahead, total);
		}
		db.exec('COMMIT');
	} finally {
		pool.close();
	}
	report('reading', total, total);
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	log(`worker: reading took ${minutes(started)} min`);
}

async function count(db, budget, index) {
	const waiting = [];
	for (let bucket = 0; bucket < BUCKETS; bucket++) {
		if (hasTable(db, heapOf(bucket))) {
			waiting.push(bucket);
		}
	}
	const indexes = GAME_INDEXES.filter(([name]) => !hasIndex(db, name));

	budget.plan('buckets', BUCKETS * 4);
	budget.phase('buckets', (BUCKETS - waiting.length) * 4);
	budget.plan('indexes', indexes.length * 8);
	budget.report();

	if (waiting.length > 0) {
		const started = Date.now();
		if (BUCKETS - waiting.length > 0) {
			log(`worker: ${BUCKETS - waiting.length} of ${BUCKETS} buckets already counted`);
		}
		const facts = gameFacts(db);
		log(`worker: results and ratings of ${facts.result.length - 1} games loaded in ${minutes(started)} min`);

		const counters = new CountPool(COUNTERS, index, facts);
		let units = (BUCKETS - waiting.length) * 4;
		const progress = (step) => {
			units += step;
			budget.phase('buckets', units);
		};

		try {
			const inFlight = [];
			let next = 0;
			let finished = 0;
			while (next < waiting.length || inFlight.length > 0) {
				while (next < waiting.length && inFlight.length <= counters.size) {
					const bucket = waiting[next++];
					sortBucket(db, bucket);
					progress(3);
					inFlight.push({ bucket, tree: counters.count(bucket, `${positionsOf(bucket)}_next`) });
				}
				const { bucket, tree } = inFlight.shift();
				finishBucket(db, bucket, await tree);
				progress(1);
				if (++finished % 4 === 0) {
					db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
				}
				if (finished % 16 === 0 || finished === waiting.length) {
					const perBucket = (Date.now() - started) / finished;
					const left = Math.round((perBucket * (waiting.length - finished)) / 60000);
					log(`worker: counted ${BUCKETS - waiting.length + finished} of ${BUCKETS} buckets, about ${left} min left`);
				}
			}
		} finally {
			counters.close();
		}
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		log(`worker: counting ${waiting.length} buckets took ${minutes(started)} min (${counters.size} count workers)`);
	}

	let built = 0;
	for (const [name, on] of indexes) {
		db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${on}`);
		budget.phase('indexes', ++built * 8);
	}
	budget.finish();
}

function sortBucket(db, bucket) {
	const heap = heapOf(bucket);
	const table = positionsOf(bucket);
	const next = `${table}_next`;
	if (hasTable(db, next)) {
		return;
	}
	const hadTable = hasTable(db, table);

	db.exec('BEGIN');
	db.exec(positionTable(next));
	const positions = db
		.prepare(
			`INSERT INTO ${next} (key, gameId, ply, moveId)
			 SELECT key, gameId, ply, moveId FROM ${heap}
			 ${hadTable ? `UNION ALL SELECT key, gameId, ply, moveId FROM ${table}` : ''}
			 ORDER BY key, gameId, ply`,
		)
		.run().changes;
	db.prepare('INSERT OR REPLACE INTO bucket (id, positions) VALUES (?, ?)').run(bucket, Number(positions));
	db.exec('COMMIT');
}

function finishBucket(db, bucket, tree) {
	const heap = heapOf(bucket);
	const table = positionsOf(bucket);
	const name = treeOf(bucket);
	const columns = '(key, moveId, games, whiteWins, draws, blackWins, topGameId)';

	db.exec('BEGIN');
	db.exec(`DROP TABLE IF EXISTS ${name}`);
	db.exec(treeTable(name));

	const many = Array(TREE_ROWS).fill('(?, ?, ?, ?, ?, ?, ?)').join(', ');
	const addMany = db.prepare(`INSERT INTO ${name} ${columns} VALUES ${many}`);
	const addOne = db.prepare(`INSERT INTO ${name} ${columns} VALUES (?, ?, ?, ?, ?, ?, ?)`);
	const { size, keys, moves, games, whiteWins, draws, blackWins, topGameId } = tree;
	const row = (at) => [
		keys.subarray(at * 12, at * 12 + 12),
		moves[at],
		games[at],
		whiteWins[at],
		draws[at],
		blackWins[at],
		topGameId[at],
	];
	let at = 0;
	const values = [];
	for (; at + TREE_ROWS <= size; at += TREE_ROWS) {
		values.length = 0;
		for (let one = at; one < at + TREE_ROWS; one++) {
			values.push(...row(one));
		}
		addMany.run(...values);
	}
	for (; at < size; at++) {
		addOne.run(...row(at));
	}

	if (hasTable(db, table)) {
		db.exec(`DROP TABLE ${table}`);
	}
	db.exec(`DROP TABLE ${heap}`);
	db.exec(`ALTER TABLE ${table}_next RENAME TO ${table}`);
	db.exec('COMMIT');
}

class CountPool {
	constructor(size, index, facts) {
		this.facts = facts;
		this.workers = [];
		this.idle = [];
		this.waiting = [];
		this.tasks = new Map();
		this.failure = null;
		this.closed = false;
		this.db = null;

		for (let at = 0; at < size; at++) {
			const worker = new Worker(unpacked(path.join(__dirname, 'count-worker.js')), {
				workerData: { index, result: facts.result.buffer, rank: facts.rank.buffer },
			});
			worker.on('message', (message) => this.settle(worker, message));
			worker.on('error', (error) => this.fail(error));
			worker.on('exit', (code) => {
				if (!this.closed) this.fail(new Error(`A count worker stopped unexpectedly (exit code ${code}).`));
			});
			this.workers.push(worker);
			this.idle.push(worker);
		}
		this.size = Math.max(1, this.workers.length);
		this.index = index;
	}

	count(bucket, table) {
		if (this.workers.length === 0) {
			// No worker threads under this fallback (used by tests): count synchronously instead.
			this.db ??= new DatabaseSync(this.index, { readOnly: true });
			return Promise.resolve(countTree(this.db, table, this.facts.result, this.facts.rank));
		}
		return new Promise((resolve, reject) => {
			if (this.failure) {
				reject(this.failure);
				return;
			}
			this.waiting.push({ bucket, table, resolve, reject });
			this.next();
		});
	}

	next() {
		while (this.idle.length > 0 && this.waiting.length > 0) {
			const worker = this.idle.pop();
			const task = this.waiting.shift();
			this.tasks.set(worker, task);
			worker.postMessage({ bucket: task.bucket, table: task.table });
		}
	}

	settle(worker, message) {
		const task = this.tasks.get(worker);
		this.tasks.delete(worker);
		this.idle.push(worker);
		if (message.error) {
			task?.reject(new Error(message.error));
		} else {
			task?.resolve(message.tree);
		}
		this.next();
	}

	fail(error) {
		if (this.failure) return;
		this.failure = error;
		for (const task of this.tasks.values()) {
			task.reject(error);
		}
		this.tasks.clear();
		for (const task of this.waiting.splice(0)) {
			task.reject(error);
		}
	}

	close() {
		this.closed = true;
		for (const worker of this.workers) {
			void worker.terminate();
		}
		this.db?.close();
	}
}

// result: 1/2/3 for white/draw/black win, 0 otherwise. rank packs strength (high bits) and year (low 12) for tie-breaking.
function gameFacts(db) {
	const top = db.prepare('SELECT MAX(id) AS top FROM game').get().top ?? 0;
	const result = new Uint8Array(new SharedArrayBuffer(top + 1));
	const rank = new Int32Array(new SharedArrayBuffer((top + 1) * 4));
	const rows = db.prepare('SELECT id, result, strength, year FROM game');
	const asArrays = typeof rows.setReturnArrays === 'function';
	if (asArrays) {
		rows.setReturnArrays(true);
	}
	for (const row of rows.iterate()) {
		const id = asArrays ? row[0] : row.id;
		const outcome = asArrays ? row[1] : row.result;
		const rated = asArrays ? row[2] : row.strength;
		const played = asArrays ? row[3] : row.year;
		result[id] = outcome === '1-0' ? 1 : outcome === '1/2-1/2' ? 2 : outcome === '0-1' ? 3 : 0;
		const s = rated === null ? 0 : Math.max(0, Math.min(rated + 1, 262143));
		const y = played === null ? 0 : Math.max(0, Math.min(played + 1, 4095));
		rank[id] = s * 4096 + y;
	}
	return { result, rank };
}

function migrate(db) {
	const started = Date.now();
	log('worker: moving the index into buckets (the PGN is not read again)');
	db.exec('DROP INDEX IF EXISTS position_key');
	db.exec('DROP TABLE IF EXISTS tree');
	for (const table of ['bucket']) {
		if (!hasTable(db, table)) {
			db.exec('CREATE TABLE bucket (id INTEGER PRIMARY KEY, positions INTEGER NOT NULL)');
		}
	}
	for (let bucket = 0; bucket < BUCKETS; bucket++) {
		db.exec(heapTable(bucket));
	}

	if (!hasTable(db, 'migration')) {
		const ends = db.prepare('SELECT MIN(rowid) AS low, MAX(rowid) AS high FROM position').get();
		db.exec('CREATE TABLE migration (low INTEGER NOT NULL, high INTEGER NOT NULL)');
		// Old rowids start at 1, so the move always began at 1 even if a previous version already started it.
		db.prepare('INSERT INTO migration (low, high) VALUES (?, ?)').run(Math.min(1, ends.low ?? 1), ends.high ?? 0);
	}
	const { low, high } = db.prepare('SELECT low, high FROM migration').get();
	const span = Math.max(1, high - low + 1);
	const left = db.prepare('SELECT MIN(rowid) AS next FROM position').get().next;
	if (left !== null && left > low) {
		log(`worker: carrying on the move into buckets at ${percentOf(left - low, span)}%`);
	}
	const heaps = new Appender(db);
	const chunk = db.prepare('SELECT rowid, key, gameId, ply, moveId FROM position ORDER BY rowid LIMIT ?');
	chunk.setReturnArrays?.(true);
	const asArrays = typeof chunk.setReturnArrays === 'function';
	const forget = db.prepare('DELETE FROM position WHERE rowid <= ?');

	let logged = -1;
	for (;;) {
		db.exec('BEGIN');
		let last = null;
		for (const row of chunk.iterate(MIGRATE_CHUNK)) {
			if (asArrays) {
				heaps.add(row[1], row[2], row[3], row[4]);
				last = row[0];
			} else {
				heaps.add(row.key, row.gameId, row.ply, row.moveId);
				last = row.rowid;
			}
		}
		heaps.flush();
		if (last === null) {
			db.exec('COMMIT');
			break;
		}
		forget.run(last);
		db.exec('COMMIT');
		report('converting', last - low + 1, span);
		const tenth = Math.floor(percentOf(last - low + 1, span) / 10);
		if (tenth !== logged) {
			logged = tenth;
			log(`worker: moved into buckets: ${percentOf(last - low + 1, span)}%`);
		}
	}

	db.exec('DROP TABLE position');
	db.exec('DROP TABLE migration');
	db.exec(`PRAGMA user_version = ${LAYOUT}`);
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	report('converting', span, span);
	log(`worker: moved into buckets in ${minutes(started)} min`);
}

// A file that changed on disk under an existing index; rare, so done the simple, unoptimized way.
function forgetSource(db, sourceId) {
	for (let bucket = 0; bucket < BUCKETS; bucket++) {
		for (const table of [heapOf(bucket), positionsOf(bucket)]) {
			if (hasTable(db, table)) {
				db.prepare(`DELETE FROM ${table} WHERE gameId IN (SELECT id FROM game WHERE sourceId = ?)`).run(sourceId);
			}
		}
		db.exec(heapTable(bucket));
	}
	db.prepare('DELETE FROM game WHERE sourceId = ?').run(sourceId);
}

class Appender {
	static ROWS = 32;

	constructor(db) {
		const many = Array(Appender.ROWS).fill('(?, ?, ?, ?)').join(', ');
		this.batch = [];
		this.single = [];
		this.waiting = [];
		for (let bucket = 0; bucket < BUCKETS; bucket++) {
			this.batch.push(db.prepare(`INSERT INTO ${heapOf(bucket)} (key, gameId, ply, moveId) VALUES ${many}`));
			this.single.push(db.prepare(`INSERT INTO ${heapOf(bucket)} (key, gameId, ply, moveId) VALUES (?, ?, ?, ?)`));
			this.waiting.push([]);
		}
	}

	add(key, gameId, ply, moveId) {
		const bucket = key[0];
		const waiting = this.waiting[bucket];
		waiting.push(key, gameId, ply, moveId);
		if (waiting.length === Appender.ROWS * 4) {
			// 4 values per row
			this.batch[bucket].run(...waiting);
			waiting.length = 0;
		}
	}

	flush() {
		for (let bucket = 0; bucket < BUCKETS; bucket++) {
			const waiting = this.waiting[bucket];
			for (let at = 0; at < waiting.length; at += 4) {
				this.single[bucket].run(waiting[at], waiting[at + 1], waiting[at + 2], waiting[at + 3]);
			}
			waiting.length = 0;
		}
	}
}

class Budget {
	constructor() {
		this.shares = new Map();
		this.done = new Map();
	}

	plan(name, units) {
		this.shares.set(name, units);
		this.done.set(name, 0);
	}

	phase(name, units) {
		this.done.set(name, units);
		this.report();
	}

	report() {
		let total = 0;
		let done = 0;
		for (const [name, units] of this.shares) {
			total += units;
			done += Math.min(units, this.done.get(name) ?? 0);
		}
		report('counting', done, Math.max(total, 1));
	}

	finish() {
		for (const [name, units] of this.shares) {
			this.done.set(name, units);
		}
		this.report();
	}
}

function hasTable(db, name) {
	return db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function hasIndex(db, name) {
	return db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name) !== undefined;
}

function percentOf(done, total) {
	return Math.min(100, Math.floor((done / Math.max(1, total)) * 100));
}

function minutes(since) {
	return ((Date.now() - since) / 60000).toFixed(1);
}

class ReplayPool {
	constructor(size, maxPly) {
		this.idle = [];
		this.waiting = [];
		this.workers = [];
		this.failure = null;
		this.closed = false;

		for (let at = 0; at < size; at++) {
			const worker = new Worker(unpacked(path.join(__dirname, 'replay-worker.js')), { workerData: { maxPly } });
			worker.task = null;
			worker.on('message', (message) => this.settle(worker, message));
			worker.on('error', (error) => this.fail(error));
			worker.on('exit', (code) => {
				if (!this.closed) this.fail(new Error(`A replay worker stopped unexpectedly (exit code ${code}).`));
			});
			this.workers.push(worker);
			this.idle.push(worker);
		}
	}

	replay(games) {
		return new Promise((resolve, reject) => {
			if (this.failure) {
				reject(this.failure);
				return;
			}
			this.waiting.push({ games, resolve, reject });
			this.next();
		});
	}

	next() {
		while (this.idle.length > 0 && this.waiting.length > 0) {
			const worker = this.idle.pop();
			const task = this.waiting.shift();
			worker.task = task;
			worker.postMessage(task.games);
		}
	}

	settle(worker, message) {
		const task = worker.task;
		worker.task = null;
		this.idle.push(worker);
		if (message.error) {
			task?.reject(new Error(message.error));
		} else {
			task?.resolve(message);
		}
		this.next();
	}

	fail(error) {
		if (this.failure) return;
		this.failure = error;
		for (const worker of this.workers) {
			worker.task?.reject(error);
			worker.task = null;
		}
		for (const task of this.waiting.splice(0)) {
			task.reject(error);
		}
	}

	close() {
		this.closed = true;
		for (const worker of this.workers) {
			void worker.terminate();
		}
	}
}

function number(value) {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function year(date) {
	const found = /^(\d{4})/.exec(date ?? '');
	return found ? Number(found[1]) : null;
}

function playedOn(date) {
	const found = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec((date ?? '').trim());
	return found ? `${found[1]}-${found[2]}-${found[3]}` : null;
}

function nameKey(raw) {
	if (!raw || raw.trim().length === 0) {
		return '';
	}
	const words = raw
		.split(/[\s,]+/)
		.map((word) =>
			word
				.normalize('NFD')
				.replace(/\p{M}/gu, '')
				.toLowerCase()
				.replace(/[^a-z0-9]/g, ''),
		)
		.filter((word) => word.length > 2)
		.sort();
	return words.filter((word, at) => at === 0 || words[at - 1] !== word).join('|');
}

function strength(whiteElo, blackElo) {
	if (whiteElo === null && blackElo === null) return null;
	return (whiteElo ?? 0) + (blackElo ?? 0);
}

if (parentPort) {
	build(workerData).then(
		(counted) => parentPort.postMessage({ type: 'done', ...counted }),
		(error) => parentPort.postMessage({ type: 'failed', message: error.message }),
	);
}

module.exports = { build, keyOf, nameKey, BUCKETS, positionsOf, treeOf };
