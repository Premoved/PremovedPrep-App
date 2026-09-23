'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const { keyOf, positionsOf, treeOf } = require('./index-worker');
const { unpacked } = require('./asar');

const DEFAULT_MAX_PLY = 40;

const INDEX_VERSION = 3;

// Not "databases": Chromium clears that name in user-data on window start-up (its own old WebSQL folder).
const INDEX_FOLDER = 'local-databases';

const SORTS = {
	STRENGTH: 'g.strength',
	WHITE_NAME: 'g.white',
	WHITE_ELO: 'g.whiteElo',
	RESULT: 'g.result',
	BLACK_NAME: 'g.black',
	BLACK_ELO: 'g.blackElo',
	DATE: 'g.date',
	EVENT: 'g.event',
};

class Databases {
	constructor(settings, directory, emit) {
		this.settings = settings;
		this.directory = path.join(directory, INDEX_FOLDER);
		this.emit = emit;
		this.open = new Map();
		this.building = new Map();
		this.progress = new Map();
		this.moveOutOfChromiumsWay(path.join(directory, 'databases'));
	}

	moveOutOfChromiumsWay(old) {
		const databases = this.settings.value.databases;
		if (!databases.some((entry) => path.dirname(entry.index) === old)) {
			return;
		}
		fs.mkdirSync(this.directory, { recursive: true });

		const moved = databases.map((entry) => {
			if (path.dirname(entry.index) !== old) {
				return entry;
			}
			const index = path.join(this.directory, path.basename(entry.index));
			return this.moveIndexGroup(entry.index, index) ? { ...entry, index } : entry;
		});
		this.settings.update({ databases: moved });
		this.log('-', `moved indexes out of ${old}`);
	}

	// Renames the main file, '-wal' and '-shm' as one unit. A failure partway (anything but a
	// missing source) rolls back what already moved, so the caller never records a new path for a
	// database that is now split across the old and new folders.
	moveIndexGroup(from, to) {
		const done = [];
		for (const suffix of ['', '-wal', '-shm']) {
			const source = `${from}${suffix}`;
			if (!fs.existsSync(source)) {
				continue;
			}
			try {
				fs.renameSync(source, `${to}${suffix}`);
				done.push(suffix);
			} catch (error) {
				for (const back of done) {
					try {
						fs.renameSync(`${to}${back}`, `${from}${back}`);
					} catch {
						// Best effort: the group is left wherever it landed.
					}
				}
				this.log('-', `failed to move ${from} out of Chromium's way: ${error.message}`);
				return false;
			}
		}
		return true;
	}

	list() {
		return this.settings.value.databases.map((entry) => ({
			...card(entry),
			running: this.building.has(entry.id),
			progress: this.progress.get(entry.id) ?? null,
		}));
	}

	async repair() {
		for (const entry of [...this.settings.value.databases]) {
			const stale = entry.version !== INDEX_VERSION;
			const unfinished = !stale && entry.ready !== true && fs.existsSync(entry.index);
			if (!stale && !unfinished) {
				if (entry.ready !== true || !fs.existsSync(entry.index)) {
					this.log(entry.id, `start-up: left alone (ready ${entry.ready === true}, ${describe(entry.index)})`);
				}
				continue;
			}
			this.log(entry.id, `start-up: ${stale ? `rebuilding, index version ${entry.version}` : 'resuming'}`);
			try {
				await (stale ? this.rebuild(entry.id) : this.resume(entry.id));
			} catch (error) {
				this.write(entry.id, { ready: false });
				this.emit('db.failed', { databaseId: entry.id, message: error.message });
			}
		}
	}

	async add(file, name) {
		const existing = this.settings.value.databases.find((entry) => sourcesOf(entry).some((one) => one.path === file));
		if (existing) {
			return card(existing);
		}

		fs.mkdirSync(this.directory, { recursive: true });
		const id = this.settings.takeDatabaseId();
		const entry = {
			id,
			name: name ?? path.basename(file).replace(/\.pgn$/i, ''),
			sources: [{ path: file, bytes: fs.statSync(file).size }],
			index: path.join(this.directory, `${id}.sqlite`),
			games: 0,
			positions: 0,
			maxPly: DEFAULT_MAX_PLY,
			indexedSources: 0,
			version: INDEX_VERSION,
			ready: false,
			updatedAt: new Date().toISOString(),
		};
		this.settings.update({ databases: [...this.settings.value.databases, entry] });
		this.emit('db.changed', {});

		try {
			const counted = await this.build(entry, true);
			this.write(id, { ...counted, ready: true, updatedAt: new Date().toISOString() });
		} catch (error) {
			// A partial index is kept so the run can resume; a file that never indexed anything is dropped.
			if (indexedGames(this.entry(id)) === 0) {
				this.drop(id);
			}
			this.emit('db.changed', {});
			throw error;
		}

		this.emit('db.changed', {});
		return card(this.entry(id));
	}

	build(entry, restart = false) {
		// One worker per index: two writing the same file at once would corrupt it.
		if (this.building.has(entry.id)) {
			return Promise.reject(new Error('This database is already being indexed.'));
		}
		this.log(
			entry.id,
			`run: ${restart ? 'from nothing' : 'carrying on'}, ${describe(entry.index)}, ${freeSpace(this.directory)}`,
		);

		const job = new Promise((resolve, reject) => {
			const worker = new Worker(unpacked(path.join(__dirname, 'index-worker.js')), {
				workerData: {
					sources: sourcesOf(entry),
					index: entry.index,
					maxPly: entry.maxPly,
					restart,
				},
			});
			this.building.set(entry.id, worker);
			let answered = false;
			const release = () => {
				answered = true;
				if (this.building.get(entry.id) === worker) {
					this.building.delete(entry.id);
					this.progress.delete(entry.id);
				}
			};

			worker.on('message', (message) => {
				if (message.type === 'log') {
					this.log(entry.id, message.text);
					return;
				}
				if (message.type === 'progress') {
					this.progress.set(entry.id, { stage: message.stage, done: message.done, total: message.total });
					this.emit('db.progress', {
						databaseId: entry.id,
						stage: message.stage,
						done: message.done,
						total: message.total,
					});
					return;
				}
				release();
				if (message.type === 'done') {
					this.log(entry.id, `done: ${message.games} games, ${message.positions} positions`);
					resolve({
						games: message.games,
						positions: message.positions,
						indexedSources: message.indexedSources,
						version: INDEX_VERSION,
					});
				} else {
					this.log(entry.id, `failed: ${message.message}`);
					reject(new Error(message.message));
				}
				void worker.terminate();
			});

			worker.on('error', (error) => {
				release();
				this.log(entry.id, `failed: ${error.message}`);
				reject(error);
			});
			worker.on('exit', (code) => {
				if (!answered) {
					this.log(entry.id, `stopped part way (exit code ${code})`);
				}
				release();
				// A worker told to stop also exits non-zero; resolve/reject already ran if 'done'/'failed' arrived first.
				if (code !== 0) {
					reject(new Error('Indexing stopped.'));
				}
			});
		});

		return job;
	}

	async append(id, file) {
		fs.mkdirSync(this.directory, { recursive: true });
		const entry = this.entry(id);
		if (!entry) {
			throw new Error(`No database with id ${id}`);
		}
		if (entry.version !== INDEX_VERSION) {
			throw new Error('Rebuild this database before adding files to it.');
		}
		if (sourcesOf(entry).some((source) => source.path === file)) {
			return card(entry);
		}

		const sources = [...sourcesOf(entry), { path: file, bytes: fs.statSync(file).size }];
		this.write(id, { sources, ready: false });
		this.emit('db.changed', {});
		return this.run(id, false);
	}

	async resume(id) {
		fs.mkdirSync(this.directory, { recursive: true });
		if (!this.entry(id)) {
			throw new Error(`No database with id ${id}`);
		}
		this.write(id, { ready: false });
		this.emit('db.changed', {});
		return this.run(id, false);
	}

	async rebuild(id) {
		fs.mkdirSync(this.directory, { recursive: true });
		if (!this.entry(id)) {
			throw new Error(`No database with id ${id}`);
		}
		this.write(id, { ready: false, version: INDEX_VERSION });
		this.emit('db.changed', {});
		return this.run(id, true);
	}

	async run(id, restart) {
		this.close(id);
		try {
			const counted = await this.build(this.entry(id), restart);
			this.write(id, { ...counted, ready: true, updatedAt: new Date().toISOString() });
			this.emit('db.changed', {});
			return card(this.entry(id));
		} catch (error) {
			this.write(id, { ready: false });
			this.emit('db.changed', {});
			this.emit('db.failed', { databaseId: id, message: error.message });
			throw error;
		}
	}

	cancel(id) {
		const worker = this.building.get(id);
		if (!worker) {
			return false;
		}
		this.log(id, 'stop requested (Stop, or the application closing)');
		void worker.terminate();
		this.building.delete(id);
		this.progress.delete(id);
		return true;
	}

	tree(databaseId, fen) {
		const db = this.reader(databaseId);
		const key = keyOf(fen);
		const tables = tablesFor(db, key);

		let rows = db
			.prepare(
				`SELECT m.san AS san, m.uci AS uci, t.games AS games,
				        t.whiteWins AS whiteWins, t.draws AS draws, t.blackWins AS blackWins,
				        g.id AS topId, g.white AS topWhite, g.whiteElo AS topWhiteElo,
				        g.black AS topBlack, g.blackElo AS topBlackElo,
				        g.result AS topResult, g.year AS topYear, g.event AS topEvent
				 FROM ${tables.tree} t
				 JOIN move m ON m.id = t.moveId
				 LEFT JOIN game g ON g.id = t.topGameId
				 WHERE t.key = ?
				 ORDER BY t.games DESC, t.whiteWins DESC`,
			)
			.all(key);

		// A position only one game reached has no tree row; read its single row from positions instead.
		if (rows.length === 0 && tables.bucketed) {
			rows = db
				.prepare(
					`SELECT m.san AS san, m.uci AS uci, 1 AS games,
					        (g.result = '1-0') AS whiteWins, (g.result = '1/2-1/2') AS draws, (g.result = '0-1') AS blackWins,
					        g.id AS topId, g.white AS topWhite, g.whiteElo AS topWhiteElo,
					        g.black AS topBlack, g.blackElo AS topBlackElo,
					        g.result AS topResult, g.year AS topYear, g.event AS topEvent
					 FROM ${tables.positions} p
					 JOIN move m ON m.id = p.moveId
					 JOIN game g ON g.id = p.gameId
					 WHERE p.key = ?`,
				)
				.all(key);
		}

		let games = 0;
		let whiteWins = 0;
		let draws = 0;
		let blackWins = 0;

		const moves = rows.map((row) => {
			games += row.games;
			whiteWins += row.whiteWins;
			draws += row.draws;
			blackWins += row.blackWins;
			return {
				san: row.san,
				uci: row.uci,
				games: row.games,
				whiteWins: row.whiteWins,
				draws: row.draws,
				blackWins: row.blackWins,
				...shares(row.whiteWins, row.draws, row.blackWins),
				topGame:
					row.topId === null
						? null
						: {
								id: row.topId,
								white: row.topWhite,
								whiteElo: row.topWhiteElo,
								black: row.topBlack,
								blackElo: row.topBlackElo,
								result: row.topResult,
								year: row.topYear,
								event: row.topEvent,
								engine: false,
							},
			};
		});

		return { fen, games, whiteWins, draws, blackWins, ...shares(whiteWins, draws, blackWins), moves };
	}

	games(databaseId, fen, sort, ascending, page, size) {
		const db = this.reader(databaseId);
		const column = SORTS[sort] ?? SORTS.STRENGTH;
		const direction = ascending ? 'ASC' : 'DESC';
		const key = keyOf(fen);

		const rows = db
			.prepare(
				`SELECT g.id, g.white, g.whiteElo, g.black, g.blackElo, g.result, g.date, g.year,
				        g.event, g.eco, p.ply AS ply
				 FROM ${tablesFor(db, key).positions} p JOIN game g ON g.id = p.gameId
				 WHERE p.key = ?
				 ORDER BY ${column} ${direction} NULLS LAST, g.id ASC
				 LIMIT ? OFFSET ?`,
			)
			.all(key, size + 1, page * size);

		return { fen, games: rows.slice(0, size), hasMore: rows.length > size };
	}

	game(databaseId, gameId) {
		const row = this.reader(databaseId)
			.prepare(
				`SELECT g.id, g.white, g.whiteElo, g.black, g.blackElo, g.result, g.date, g.year, g.event, g.site,
				        g.round, g.eco, g.start, g.length, s.path AS file
				 FROM game g JOIN source s ON s.id = g.sourceId
				 WHERE g.id = ?`,
			)
			.get(gameId);

		if (!row) {
			return null;
		}

		// The game text is never copied into the index; it is read back from its byte offset in the source PGN.
		const handle = fs.openSync(row.file, 'r');
		try {
			const buffer = Buffer.alloc(row.length);
			fs.readSync(handle, buffer, 0, row.length, row.start);
			const { start, length, file, ...rest } = row;
			return { ...rest, pgn: buffer.toString('utf8').trim() };
		} finally {
			fs.closeSync(handle);
		}
	}

	players(databaseId, query, limit = 12) {
		const db = this.reader(databaseId);
		const like = `%${(query ?? '').trim().toLowerCase()}%`;
		return db
			.prepare(
				`SELECT name, MAX(elo) AS topElo FROM (
				        SELECT white AS name, whiteElo AS elo FROM game WHERE lower(white) LIKE ?
				        UNION ALL
				        SELECT black AS name, blackElo AS elo FROM game WHERE lower(black) LIKE ?
				 )
				 GROUP BY name
				 ORDER BY topElo DESC NULLS LAST, name ASC
				 LIMIT ?`,
			)
			.all(like, like, Math.max(1, Math.min(limit, 50)));
	}

	opponent(databaseId, { nameKeys, color, from, to, sort, ascending, page, size }) {
		const side = color === 'b' ? 'blackKey' : 'whiteKey';
		const where = [];
		const args = [];

		if (Array.isArray(nameKeys) && nameKeys.length > 0) {
			where.push(`g.${side} IN (${nameKeys.map(() => '?').join(', ')})`);
			args.push(...nameKeys);
		} else {
			where.push('1 = 0');
		}

		dateBounds(where, args, from, to);
		return this.page(databaseId, where, args, sort, ascending, page, size);
	}

	opponentTree(databaseId, { nameKeys, color, from, to, fen }) {
		const db = this.reader(databaseId);
		const side = color === 'b' ? 'blackKey' : 'whiteKey';

		if (!Array.isArray(nameKeys) || nameKeys.length === 0) {
			return { fen, games: 0, whiteWins: 0, draws: 0, blackWins: 0, whitePct: 0, drawPct: 0, blackPct: 0, moves: [] };
		}

		const key = keyOf(fen);
		const where = [`g.${side} IN (${nameKeys.map(() => '?').join(', ')})`];
		const args = [key, ...nameKeys];
		dateBounds(where, args, from, to);

		const rows = db
			.prepare(
				`SELECT m.san AS san, m.uci AS uci, COUNT(*) AS games,
				        SUM(g.result = '1-0') AS whiteWins,
				        SUM(g.result = '1/2-1/2') AS draws,
				        SUM(g.result = '0-1') AS blackWins
				 FROM ${tablesFor(db, key).positions} p
				 JOIN game g ON g.id = p.gameId
				 JOIN move m ON m.id = p.moveId
				 WHERE p.key = ? AND ${where.join(' AND ')}
				 GROUP BY p.moveId
				 ORDER BY games DESC, whiteWins DESC`,
			)
			.all(...args);

		let games = 0;
		let whiteWins = 0;
		let draws = 0;
		let blackWins = 0;
		const moves = rows.map((row) => {
			games += row.games;
			whiteWins += row.whiteWins;
			draws += row.draws;
			blackWins += row.blackWins;
			return {
				san: row.san,
				uci: row.uci,
				games: row.games,
				whiteWins: row.whiteWins,
				draws: row.draws,
				blackWins: row.blackWins,
				...shares(row.whiteWins, row.draws, row.blackWins),
				topGame: null,
			};
		});

		return { fen, games, whiteWins, draws, blackWins, ...shares(whiteWins, draws, blackWins), moves };
	}

	search(databaseId, criteria) {
		const where = [];
		const args = [];

		names(where, args, criteria.white, criteria.black, criteria.ignoreColours === true);
		range(where, args, 'g.whiteElo', criteria.whiteEloMin, criteria.whiteEloMax);
		range(where, args, 'g.blackElo', criteria.blackEloMin, criteria.blackEloMax);
		dateBounds(where, args, criteria.from, criteria.to);

		if (text(criteria.event)) {
			where.push('lower(g.event) LIKE ?');
			args.push(`%${criteria.event.trim().toLowerCase()}%`);
		}
		if (text(criteria.eco)) {
			where.push('upper(g.eco) LIKE ?');
			args.push(`${criteria.eco.trim().toUpperCase()}%`);
		}
		if (Array.isArray(criteria.results) && criteria.results.length > 0) {
			where.push(`g.result IN (${criteria.results.map(() => '?').join(', ')})`);
			args.push(...criteria.results);
		}

		return this.page(databaseId, where, args, criteria.sort, criteria.ascending, criteria.page, criteria.size);
	}

	page(databaseId, where, args, sort, ascending, page = 0, size = 50) {
		const db = this.reader(databaseId);
		const column = SEARCH_SORTS[sort] ?? SEARCH_SORTS.DATE;
		const direction = ascending ? 'ASC' : 'DESC';
		const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

		const rows = db
			.prepare(
				`SELECT g.id, g.white, g.whiteElo, g.black, g.blackElo, g.result, g.date, g.year,
				        g.event, g.site, g.round, g.eco, g.plyCount
				 FROM game g
				 ${filter}
				 ORDER BY ${column} ${direction} NULLS LAST, g.id ASC
				 LIMIT ? OFFSET ?`,
			)
			.all(...args, size + 1, page * size);

		return {
			games: rows.slice(0, size).map((row) => ({
				...row,
				whiteFideId: null,
				whiteFideName: null,
				blackFideId: null,
				blackFideName: null,
			})),
			hasMore: rows.length > size,
			page,
		};
	}

	remove(id) {
		const entry = this.entry(id);
		if (!entry) {
			return false;
		}
		this.cancel(id);
		this.close(id);
		this.drop(id);
		this.emit('db.changed', {});
		return true;
	}

	closeAll() {
		for (const id of [...this.open.keys()]) {
			this.close(id);
		}
		for (const id of [...this.building.keys()]) {
			this.cancel(id);
		}
	}

	close(id) {
		const db = this.open.get(id);
		if (db) {
			db.close();
			this.open.delete(id);
		}
	}

	entry(id) {
		return this.settings.value.databases.find((database) => database.id === id) ?? null;
	}

	reader(id) {
		const held = this.open.get(id);
		if (held) {
			return held;
		}
		const entry = this.entry(id);
		if (!entry) {
			throw new Error(`No database with id ${id}`);
		}
		if (!entry.ready) {
			throw new Error('That database is still being indexed.');
		}
		if (entry.version !== INDEX_VERSION) {
			throw new Error('That database was indexed by an older version. Rebuild it from Local resources.');
		}
		const db = new DatabaseSync(entry.index, { readOnly: true });
		this.open.set(id, db);
		return db;
	}

	log(id, text) {
		try {
			fs.mkdirSync(this.directory, { recursive: true });
			fs.appendFileSync(path.join(this.directory, 'indexing.log'), `${new Date().toISOString()} #${id} ${text}\n`);
		} catch {
			// Logging is best effort.
		}
	}

	write(id, patch) {
		this.settings.update({
			databases: this.settings.value.databases.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
		});
	}

	drop(id) {
		const entry = this.entry(id);
		this.log(id, 'removed, with its index');
		if (entry) {
			fs.rmSync(entry.index, { force: true });
		}
		this.settings.update({ databases: this.settings.value.databases.filter((database) => database.id !== id) });
	}
}

const SEARCH_SORTS = {
	DATE: 'g.playedOn',
	STRENGTH: 'g.strength',
	WHITE_NAME: 'g.white',
	BLACK_NAME: 'g.black',
	WHITE_ELO: 'g.whiteElo',
	BLACK_ELO: 'g.blackElo',
	RESULT: 'g.result',
	EVENT: 'g.event',
	ECO: 'g.eco',
	MOVES: 'g.plyCount',
};

function dateBounds(where, args, from, to) {
	bound(where, args, from, '>=');
	bound(where, args, to, '<=');
}

// A game dated "2026.??.??" has a year but no day, so the bound applies to whichever column it has.
function bound(where, args, iso, op) {
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? '').trim());
	if (!day) {
		return;
	}
	where.push(`(g.playedOn ${op} ? OR (g.playedOn IS NULL AND g.year ${op} ?))`);
	args.push(day[0], Number(day[1]));
}

function range(where, args, column, min, max) {
	if (Number.isFinite(min)) {
		where.push(`${column} >= ?`);
		args.push(min);
	}
	if (Number.isFinite(max)) {
		where.push(`${column} <= ?`);
		args.push(max);
	}
}

function names(where, args, white, black, ignoreColours) {
	const one = text(white) ? `%${white.trim().toLowerCase()}%` : null;
	const two = text(black) ? `%${black.trim().toLowerCase()}%` : null;

	if (ignoreColours && one && two) {
		where.push(
			'((lower(g.white) LIKE ? AND lower(g.black) LIKE ?) OR (lower(g.white) LIKE ? AND lower(g.black) LIKE ?))',
		);
		args.push(one, two, two, one);
		return;
	}
	if (ignoreColours && (one || two)) {
		const only = one ?? two;
		where.push('(lower(g.white) LIKE ? OR lower(g.black) LIKE ?)');
		args.push(only, only);
		return;
	}
	if (one) {
		where.push('lower(g.white) LIKE ?');
		args.push(one);
	}
	if (two) {
		where.push('lower(g.black) LIKE ?');
		args.push(two);
	}
}

function text(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

function shares(whiteWins, draws, blackWins) {
	const decided = whiteWins + draws + blackWins;
	if (decided === 0) {
		return { whitePct: 0, drawPct: 0, blackPct: 0 };
	}
	return {
		whitePct: (whiteWins / decided) * 100,
		drawPct: (draws / decided) * 100,
		blackPct: (blackWins / decided) * 100,
	};
}

function sourcesOf(entry) {
	if (Array.isArray(entry.sources) && entry.sources.length > 0) {
		return entry.sources;
	}
	return entry.path ? [{ path: entry.path, bytes: entry.bytes ?? 0 }] : [];
}

function describe(index) {
	try {
		const bytes = fs.statSync(index).size;
		return `index ${(bytes / 1e9).toFixed(2)} GB`;
	} catch {
		return 'no index file';
	}
}

function freeSpace(directory) {
	try {
		fs.mkdirSync(directory, { recursive: true });
		const disk = fs.statfsSync(directory);
		return `${((disk.bavail * disk.bsize) / 1e9).toFixed(1)} GB free`;
	} catch {
		return 'free space unknown';
	}
}

// An index built before positions were split into per-first-byte buckets has one shared table of each.
const layouts = new WeakMap();
function tablesFor(db, key) {
	let bucketed = layouts.get(db);
	if (bucketed === undefined) {
		bucketed =
			db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'pos_00'`).get() !== undefined;
		layouts.set(db, bucketed);
	}
	return bucketed
		? { bucketed, positions: positionsOf(key[0]), tree: treeOf(key[0]) }
		: { bucketed, positions: 'position', tree: 'tree' };
}

function indexedGames(entry) {
	if (!entry || !fs.existsSync(entry.index)) {
		return 0;
	}
	try {
		const db = new DatabaseSync(entry.index, { readOnly: true });
		const counted = db.prepare('SELECT COUNT(*) AS games FROM game').get().games;
		db.close();
		return counted;
	} catch {
		return 0;
	}
}

function card(entry) {
	const sources = sourcesOf(entry);
	return {
		id: entry.id,
		name: entry.name,
		path: sources[0]?.path ?? '',
		files: sources.map((source) => source.path),
		games: entry.games,
		positions: entry.positions,
		maxPly: entry.maxPly,
		bytes: sources.reduce((total, source) => total + (source.bytes ?? 0), 0),
		ready: entry.ready === true && entry.version === INDEX_VERSION,
		stale: entry.ready === true && entry.version !== INDEX_VERSION,
		paused: entry.ready !== true && entry.version === INDEX_VERSION && fs.existsSync(entry.index),
		updatedAt: entry.updatedAt,
	};
}

module.exports = { Databases, DEFAULT_MAX_PLY };
