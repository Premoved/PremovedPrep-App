'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const { isPrepared } = require('./index-worker');
const { unpacked } = require('./asar');
const { QueryPool } = require('./query-pool');

const DEFAULT_MAX_PLY = 40;

const INDEX_VERSION = 3;

// Not "databases": Chromium clears that name in user-data on window start-up (its own old WebSQL folder).
const INDEX_FOLDER = 'local-databases';

class Databases {
	constructor(settings, directory, emit) {
		this.settings = settings;
		this.directory = path.join(directory, INDEX_FOLDER);
		this.emit = emit;
		this.building = new Map();
		this.progress = new Map();
		// Runs stopped on purpose (Stop, Remove, the application closing): their end is not a failure.
		this.stopped = new Set();
		this.preparing = new Map();
		// Seconds a query may take: position lookups, then searches and the report's game reading.
		this.queries = new QueryPool({ fast: 15_000, heavy: 30_000 }, { log: (text) => this.log('-', text) });
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
			} catch {
				// run() has already recorded the reason on the entry and announced it.
			}
		}
		await this.prepareAll();
	}

	// Indexes made before the sort indexes and the name list get them here, once, while staying usable.
	async prepareAll() {
		for (const entry of [...this.settings.value.databases]) {
			if (entry.ready !== true || entry.version !== INDEX_VERSION || this.building.has(entry.id)) {
				continue;
			}
			if (prepared(entry)) {
				continue;
			}
			try {
				await this.prepare(entry.id);
			} catch {
				// Logged; the next start tries again, and searches work meanwhile, only slower.
			}
		}
	}

	prepare(id) {
		const entry = this.entry(id);
		if (!entry || this.preparing.has(id) || this.building.has(id)) {
			return Promise.resolve(false);
		}
		this.log(id, `preparing: sort indexes and the name list, ${freeSpace(this.directory)}`);

		return new Promise((resolve, reject) => {
			const worker = new Worker(unpacked(path.join(__dirname, 'index-worker.js')), {
				workerData: { index: entry.index, prepareOnly: true, sources: [], maxPly: entry.maxPly },
			});
			this.preparing.set(id, worker);
			let answered = false;
			const release = () => {
				if (this.preparing.get(id) === worker) {
					this.preparing.delete(id);
					this.progress.delete(id);
				}
			};

			worker.on('message', (message) => {
				if (message.type === 'log') {
					this.log(id, message.text);
					return;
				}
				if (message.type === 'progress') {
					this.progress.set(id, { stage: message.stage, done: message.done, total: message.total });
					this.emit('db.progress', { databaseId: id, stage: message.stage, done: message.done, total: message.total });
					return;
				}
				answered = true;
				release();
				this.emit('db.changed', {});
				if (message.type === 'done') {
					this.log(id, 'prepared');
					resolve(true);
				} else {
					this.log(id, `preparing failed: ${message.message}`);
					reject(new Error(message.message));
				}
				void worker.terminate();
			});
			worker.on('error', (error) => {
				answered = true;
				release();
				this.log(id, `preparing failed: ${error.message}`);
				this.emit('db.changed', {});
				reject(error);
			});
			worker.on('exit', (code) => {
				release();
				if (!answered) {
					this.log(id, `preparing stopped (exit code ${code})`);
					this.emit('db.changed', {});
					resolve(false);
				}
			});
		});
	}

	// Resolves when the preparing thread has really ended: until then it may still hold the write lock.
	async stopPreparing(id) {
		const worker = this.preparing.get(id);
		if (!worker) {
			return;
		}
		this.log(id, 'preparing stopped, to be carried on later');
		this.preparing.delete(id);
		this.progress.delete(id);
		await worker.terminate();
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
			failure: null,
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
			this.write(id, { ...counted, ready: true, failure: null, updatedAt: new Date().toISOString() });
		} catch (error) {
			this.failed(id, entry.name, error);
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
		await this.stopPreparing(id);
		await this.close(id);
		this.write(id, { failure: null });
		try {
			const counted = await this.build(this.entry(id), restart);
			this.write(id, { ...counted, ready: true, failure: null, updatedAt: new Date().toISOString() });
			this.emit('db.changed', {});
			return card(this.entry(id));
		} catch (error) {
			this.write(id, { ready: false });
			this.failed(id, this.entry(id)?.name ?? null, error);
			this.emit('db.changed', {});
			throw error;
		}
	}

	// Kept on the entry, so the reason is still there for a page opened later or after a restart,
	// and announced, for a database that is dropped because nothing of it was indexed.
	failed(id, name, error) {
		if (this.stopped.delete(id)) {
			return;
		}
		const message = reasonFor(error);
		if (this.entry(id)) {
			this.write(id, { failure: message });
		}
		this.emit('db.failed', { databaseId: id, name, message });
	}

	cancel(id) {
		const worker = this.building.get(id);
		if (!worker) {
			return false;
		}
		this.log(id, 'stop requested (Stop, or the application closing)');
		this.stopped.add(id);
		void worker.terminate();
		this.building.delete(id);
		this.progress.delete(id);
		return true;
	}

	tree(databaseId, fen, channel) {
		return this.ask('fast', databaseId, 'tree', { fen }, channel);
	}

	games(databaseId, fen, sort, ascending, page, size, channel) {
		return this.ask('fast', databaseId, 'games', { fen, sort, ascending, page, size }, channel);
	}

	game(databaseId, gameId, channel) {
		return this.ask('fast', databaseId, 'game', { gameId }, channel);
	}

	players(databaseId, q, limit, channel) {
		return this.ask('heavy', databaseId, 'players', { q, limit }, channel);
	}

	opponent(databaseId, scope, channel) {
		return this.ask('fast', databaseId, 'opponent', scope, channel);
	}

	opponentGames(databaseId, scope, channel) {
		return this.ask('heavy', databaseId, 'opponentGames', scope, channel);
	}

	opponentTree(databaseId, scope, channel) {
		return this.ask('fast', databaseId, 'opponentTree', scope, channel);
	}

	search(databaseId, criteria, channel) {
		return this.ask('heavy', databaseId, 'search', criteria, channel);
	}

	async ask(lane, databaseId, method, args, channel) {
		const index = this.readable(databaseId);
		try {
			return await this.queries.request(lane, index, method, args, channel ?? null);
		} catch (error) {
			if (error.code === 'TIMEOUT' && this.preparing.has(databaseId)) {
				error.message =
					'This database is still being prepared for fast searches (Local resources shows how far). ' +
					'Try again when that finishes.';
			}
			throw error;
		}
	}

	async remove(id) {
		const entry = this.entry(id);
		if (!entry) {
			return false;
		}
		this.cancel(id);
		await this.stopPreparing(id);
		await this.close(id);
		this.drop(id);
		this.emit('db.changed', {});
		return true;
	}

	closeAll() {
		this.queries.close();
		for (const id of [...this.building.keys()]) {
			this.cancel(id);
		}
		for (const worker of this.preparing.values()) {
			void worker.terminate();
		}
		this.preparing.clear();
	}

	close(id) {
		const entry = this.entry(id);
		return entry ? this.queries.release(entry.index) : Promise.resolve();
	}

	entry(id) {
		return this.settings.value.databases.find((database) => database.id === id) ?? null;
	}

	readable(id) {
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
		return entry.index;
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

function indexedGames(entry) {
	if (!entry || !fs.existsSync(entry.index)) {
		return 0;
	}
	try {
		const db = new DatabaseSync(entry.index, { readOnly: true });
		const any = db.prepare('SELECT 1 AS found FROM game LIMIT 1').get() !== undefined;
		db.close();
		return any ? 1 : 0;
	} catch {
		return 0;
	}
}

// True when it cannot be read either: a broken index is for the next indexing run to report, not this check.
function prepared(entry) {
	try {
		const db = new DatabaseSync(entry.index, { readOnly: true });
		try {
			return isPrepared(db);
		} finally {
			db.close();
		}
	} catch {
		return true;
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
		failure: entry.ready === true ? null : (entry.failure ?? null),
		updatedAt: entry.updatedAt,
	};
}

// One readable line for the page; the full message and stack stay in indexing.log.
function reasonFor(error) {
	const message = String(error?.message ?? error ?? '');
	if (/Cannot find module/i.test(message)) {
		return 'A file the application needs is missing. Reinstalling the application should fix this.';
	}
	if (/^Indexing stopped\.?$/.test(message)) {
		return 'The indexing process ended unexpectedly. Details are in indexing.log.';
	}
	return message.split('\n')[0].trim() || 'Indexing failed. Details are in indexing.log.';
}

module.exports = { Databases, DEFAULT_MAX_PLY };
