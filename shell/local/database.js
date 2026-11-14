'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const { isPrepared } = require('./index-worker');
const { unpacked } = require('./asar');
const { QueryPool } = require('./query-pool');

const DEFAULT_MAX_PLY = 40;

const INDEX_VERSION = 3;

// The layout of an index file (its user_version), as index-worker.js writes it.
const LAYOUT = 4;

// Marks a file made by Export, in its meta table. Raised only if an export ever needs reading differently.
const EXPORT_FORMAT = 1;

// Large and rebuilt from the PGN if lost, so not in the roaming profile. Elsewhere, beside the
// settings; not "databases" there: Chromium clears that name in user data on window start-up.
function databaseFolder(userData) {
	if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
		return path.join(process.env.LOCALAPPDATA, 'PremovedPrep', 'Databases');
	}
	return path.join(userData, 'local-databases');
}

// Where earlier versions kept the indexes.
const OLD_FOLDERS = ['local-databases', 'databases'];

// Names Windows reserves for devices, whatever the extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

class Databases {
	constructor(settings, directory, emit) {
		this.settings = settings;
		this.directory = databaseFolder(directory);
		this.oldFolders = OLD_FOLDERS.map((name) => path.join(directory, name)).filter((old) => old !== this.directory);
		this.emit = emit;
		this.building = new Map();
		this.progress = new Map();
		// Runs stopped on purpose (Stop, Remove, the application closing): their end is not a failure.
		this.stopped = new Set();
		this.preparing = new Map();
		// Databases being exported or imported: a copy of the file is being made.
		this.copying = new Set();
		// Seconds a query may take: position lookups, then searches and the report's game reading.
		this.queries = new QueryPool({ fast: 15_000, heavy: 30_000 }, { log: (text) => this.log('-', text) });
		this.forgetImports();
		this.relocate();
	}

	// An import the application closed in the middle of: its half copy is deleted and it leaves the list.
	forgetImports() {
		const databases = this.settings.value.databases;
		const unfinished = databases.filter((entry) => entry.importing === true);
		if (unfinished.length === 0) {
			return;
		}
		for (const entry of unfinished) {
			this.log(entry.id, 'start-up: import not finished, removed');
			removeGroup(`${entry.index}.part`);
		}
		this.settings.update({ databases: databases.filter((entry) => entry.importing !== true) });
	}

	// Every index into the database folder, named after its database: from an earlier version's
	// folder, or from a numbered name. One that cannot be moved (locked, another disk) stays where
	// it is and keeps working; the next start tries again.
	relocate() {
		// First, so what is logged below lands in the log carried over.
		for (const old of this.oldFolders) {
			const log = path.join(old, 'indexing.log');
			if (fs.existsSync(log) && !fs.existsSync(path.join(this.directory, 'indexing.log'))) {
				try {
					fs.mkdirSync(this.directory, { recursive: true });
					fs.renameSync(log, path.join(this.directory, 'indexing.log'));
				} catch {
					// The old log is only history.
				}
			}
		}
		const databases = this.settings.value.databases;
		const taken = new Set();
		let changed = false;
		const moved = databases.map((entry) => {
			const index = path.join(this.directory, this.fileNameFor(entry, taken));
			taken.add(path.basename(index).toLowerCase());
			if (samePath(entry.index, index)) {
				return entry;
			}
			fs.mkdirSync(this.directory, { recursive: true });
			if (!fs.existsSync(entry.index)) {
				changed = true;
				return { ...entry, index };
			}
			if (!this.moveIndexGroup(entry.index, index)) {
				taken.delete(path.basename(index).toLowerCase());
				taken.add(path.basename(entry.index).toLowerCase());
				return entry;
			}
			this.log(entry.id, `moved ${entry.index} to ${index}`);
			changed = true;
			return { ...entry, index };
		});
		if (changed) {
			this.settings.update({ databases: moved });
		}
	}

	// The database's name as a file name, unique in the folder: "TGigabase2.sqlite", "TGigabase2 (2).sqlite".
	fileNameFor(entry, taken) {
		const current = path.basename(entry.index ?? '');
		let base = String(entry.name ?? '')
			.normalize('NFC')
			.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/[. ]+$/, '')
			.slice(0, 80)
			.trim();
		if (base.length === 0 || RESERVED.test(base)) {
			base = `Database ${entry.id}`;
		}
		const onDisk = (name) =>
			name.toLowerCase() !== current.toLowerCase() && fs.existsSync(path.join(this.directory, name));
		for (let copy = 1; ; copy++) {
			const name = copy === 1 ? `${base}.sqlite` : `${base} (${copy}).sqlite`;
			if (!taken.has(name.toLowerCase()) && !onDisk(name)) {
				return name;
			}
		}
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
			running: this.building.has(entry.id) || this.copying.has(entry.id),
			progress: this.progress.get(entry.id) ?? null,
		}));
	}

	async repair() {
		this.sweep();
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
		if (!entry || this.preparing.has(id) || this.building.has(id) || this.copying.has(id)) {
			return Promise.resolve(false);
		}
		this.log(id, `preparing: indexes, FIDE ids and the name list, ${freeSpace(this.directory)}`);

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
		const label = name ?? path.basename(file).replace(/\.pgn$/i, '');
		const taken = new Set(this.settings.value.databases.map((entry) => path.basename(entry.index).toLowerCase()));
		const entry = {
			id,
			name: label,
			sources: [{ path: file, bytes: fs.statSync(file).size }],
			index: path.join(this.directory, this.fileNameFor({ id, name: label, index: '' }, taken)),
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
		if (this.copying.has(entry.id)) {
			return Promise.reject(new Error('Wait for the export of this database to finish.'));
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
		const entry = this.entry(id);
		if (!entry) {
			throw new Error(`No database with id ${id}`);
		}
		// Rebuilding starts by deleting the index: without every PGN it was made from, that loses games.
		const absent = sourcesOf(entry).find((source) => !path.isAbsolute(source.path) || !fs.existsSync(source.path));
		if (absent) {
			throw new Error(
				`"${path.win32.basename(absent.path)}" is not on this computer, so this database cannot be rebuilt.`,
			);
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
		if (this.copying.has(id)) {
			throw new Error('Wait for the copy of this database to finish.');
		}
		this.cancel(id);
		await this.stopPreparing(id);
		await this.close(id);
		this.drop(id);
		this.emit('db.changed', {});
		return true;
	}

	// One file with the whole database, which Import opens on any computer without its PGNs.
	async exportTo(id, target) {
		const entry = this.entry(id);
		if (!entry) {
			throw new Error(`No database with id ${id}`);
		}
		if (entry.ready !== true || entry.version !== INDEX_VERSION || this.building.has(id)) {
			throw new Error('Only a database that is fully indexed can be exported.');
		}
		if (this.preparing.has(id) || !prepared(entry)) {
			throw new Error('This database is still being prepared for fast searches. Export it when that finishes.');
		}
		if (this.copying.has(id)) {
			throw new Error('This database is already being copied.');
		}
		if (samePath(target, entry.index)) {
			throw new Error('Choose another place for the export.');
		}

		this.copying.add(id);
		const part = `${target}.part`;
		this.log(id, `export to ${target}`);
		try {
			await this.close(id);
			checkpoint(entry.index);
			const bytes = fs.statSync(entry.index).size;
			roomFor(path.dirname(target), bytes);
			await this.copy(id, 'exporting', entry.index, part, bytes);
			seal(part, entry.maxPly ?? DEFAULT_MAX_PLY);
			fs.renameSync(part, target);
			this.log(id, `exported, ${(bytes / 1e9).toFixed(2)} GB`);
			return target;
		} catch (error) {
			removeGroup(part);
			this.log(id, `export failed: ${error.message}`);
			throw error;
		} finally {
			this.copying.delete(id);
			this.progress.delete(id);
			this.emit('db.changed', {});
		}
	}

	// A file made by Export, copied in as a database of its own. Listed while it copies, so its
	// progress shows; it leaves the list again if the file is not a whole, current export.
	async importFrom(file) {
		const bytes = fs.statSync(file).size;
		fs.mkdirSync(this.directory, { recursive: true });
		roomFor(this.directory, bytes);

		const id = this.settings.takeDatabaseId();
		const name =
			path
				.basename(file)
				.replace(/\.ppdb$/i, '')
				.trim() || `Database ${id}`;
		const taken = new Set(this.settings.value.databases.map((entry) => path.basename(entry.index).toLowerCase()));
		const index = path.join(this.directory, this.fileNameFor({ id, name, index: '' }, taken));
		const part = `${index}.part`;
		this.settings.update({
			databases: [
				...this.settings.value.databases,
				{
					id,
					name,
					sources: [],
					index,
					failure: null,
					games: 0,
					positions: 0,
					maxPly: DEFAULT_MAX_PLY,
					indexedSources: 0,
					version: INDEX_VERSION,
					ready: false,
					importing: true,
					updatedAt: new Date().toISOString(),
				},
			],
		});
		this.copying.add(id);
		this.log(id, `import from ${file}`);
		this.emit('db.changed', {});

		try {
			await this.copy(id, 'importing', file, part, bytes);
			const found = opened(part);
			fs.renameSync(part, index);
			this.write(id, {
				...found,
				indexedSources: found.sources.length,
				ready: true,
				importing: false,
				updatedAt: new Date().toISOString(),
			});
			this.log(id, `imported: ${found.games} games, ${found.positions} positions`);
			return card(this.entry(id));
		} catch (error) {
			removeGroup(part);
			this.log(id, `import failed: ${error.message}${error.detail ? ` (${error.detail})` : ''}`);
			this.settings.update({ databases: this.settings.value.databases.filter((entry) => entry.id !== id) });
			throw error;
		} finally {
			this.copying.delete(id);
			this.progress.delete(id);
			this.emit('db.changed', {});
		}
	}

	// A plain file copy, with its progress shown on the database's row.
	async copy(id, stage, from, to, total) {
		const report = (done) => {
			this.progress.set(id, { stage, done, total });
			this.emit('db.progress', { databaseId: id, stage, done, total });
		};
		report(0);
		let done = 0;
		let shown = 0;
		const source = fs.createReadStream(from, { highWaterMark: 4 << 20 });
		source.on('data', (chunk) => {
			done += chunk.length;
			if (done - shown >= total / 100) {
				shown = done;
				report(done);
			}
		});
		await pipeline(source, fs.createWriteStream(to));
		if (done !== total) {
			throw new Error('The file changed while it was being copied. Try again.');
		}
		report(total);
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

	/** The index file of a database, for showing it in the file manager. */
	location(id) {
		const entry = this.entry(id);
		if (!entry) {
			throw new Error(`No database with id ${id}`);
		}
		return entry.index;
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
			for (const suffix of ['', '-wal', '-shm']) {
				fs.rmSync(`${entry.index}${suffix}`, { force: true });
			}
		}
		this.settings.update({ databases: this.settings.value.databases.filter((database) => database.id !== id) });
	}

	// SQLite's -wal and -shm files of databases removed by an earlier version, which left them behind.
	sweep() {
		const kept = new Set(this.settings.value.databases.map((entry) => path.resolve(entry.index).toLowerCase()));
		for (const folder of [this.directory, ...this.oldFolders]) {
			let names;
			try {
				names = fs.readdirSync(folder);
			} catch {
				continue;
			}
			for (const name of names) {
				const owner = /^(.+\.sqlite)-(wal|shm)$/.exec(name)?.[1];
				if (!owner || names.includes(owner) || kept.has(path.resolve(folder, owner).toLowerCase())) {
					continue;
				}
				try {
					fs.rmSync(path.join(folder, name), { force: true });
				} catch {
					// In use or locked: left for the next start.
				}
			}
		}
		for (const old of this.oldFolders) {
			try {
				// Only when empty: anything else in it is not ours to delete.
				fs.rmdirSync(old);
			} catch {
				// Not empty, or not there.
			}
		}
	}
}

// Everything written so far into the main file, so that file alone is the whole database.
function checkpoint(index) {
	const db = new DatabaseSync(index);
	try {
		db.exec('PRAGMA busy_timeout = 5000');
		if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy) {
			throw new Error('This database is busy. Try again in a moment.');
		}
	} finally {
		db.close();
	}
}

// Turns a copy of an index into an export: one file (no -wal beside it), marked as an export, and
// with only the names of the PGNs it was made from: their folders mean nothing on another computer.
function seal(file, maxPly) {
	const db = new DatabaseSync(file);
	try {
		db.exec('PRAGMA journal_mode = DELETE');
		const set = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
		set.run('export', EXPORT_FORMAT);
		set.run('indexVersion', INDEX_VERSION);
		set.run('maxPly', maxPly);
		const rename = db.prepare('UPDATE source SET path = ? WHERE id = ?');
		for (const row of db.prepare('SELECT id, path FROM source').all()) {
			rename.run(path.win32.basename(row.path), row.id);
		}
	} finally {
		db.close();
	}
}

class ImportError extends Error {
	constructor(message, code = 'FAILED', detail = null) {
		super(message);
		this.code = code;
		// For indexing.log only.
		this.detail = detail;
	}
}

const NOT_AN_EXPORT = 'This file is not a database exported from PremovedPrep.';
const INCOMPLETE = 'This file is not a whole export. Export the database again and import the new file.';

// What the list needs about an imported file, once it is known to be a whole export this version
// reads; the file is then switched to WAL like every other index.
function opened(file) {
	let db;
	try {
		db = new DatabaseSync(file);
	} catch {
		throw new ImportError(NOT_AN_EXPORT);
	}
	try {
		let layout;
		try {
			layout = db.prepare('PRAGMA user_version').get().user_version;
		} catch {
			throw new ImportError(NOT_AN_EXPORT);
		}
		if (!['game', 'source', 'meta', 'bucket'].every((table) => tableIn(db, table)) || metaIn(db, 'export') === null) {
			throw new ImportError(NOT_AN_EXPORT);
		}
		const version = metaIn(db, 'indexVersion');
		if (metaIn(db, 'export') > EXPORT_FORMAT || version > INDEX_VERSION || layout > LAYOUT) {
			throw new ImportError(
				'This database was exported by a newer version of PremovedPrep. Update the app, then import it again.',
				'NEWER_VERSION',
			);
		}
		if (version !== INDEX_VERSION || layout !== LAYOUT) {
			throw new ImportError(
				'This database was exported by an older version of PremovedPrep. Export it again from the latest version.',
			);
		}
		const pages = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
		if (fs.statSync(file).size < pages || !isPrepared(db)) {
			throw new ImportError(INCOMPLETE);
		}
		const rows = db.prepare('SELECT id, path, bytes, done FROM source ORDER BY id').all();
		if (rows.some((row, at) => row.id !== at + 1 || row.done !== 1)) {
			throw new ImportError(INCOMPLETE);
		}
		const games = db.prepare('SELECT COUNT(*) AS n FROM game').get().n;
		const positions = db.prepare('SELECT COALESCE(SUM(positions), 0) AS n FROM bucket').get().n;
		const maxPly = Number(metaIn(db, 'maxPly') ?? DEFAULT_MAX_PLY);
		db.exec('PRAGMA journal_mode = WAL');
		return {
			sources: rows.map((row) => ({ path: row.path, bytes: row.bytes })),
			games,
			positions,
			maxPly,
		};
	} catch (error) {
		if (error instanceof ImportError) {
			throw error;
		}
		// SQLite's own complaints (not a database, malformed): the file is not one this can use.
		throw new ImportError(NOT_AN_EXPORT, 'FAILED', String(error?.message ?? error).split('\n')[0]);
	} finally {
		db.close();
	}
}

function tableIn(db, name) {
	return db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function metaIn(db, key) {
	return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

// Refuses before copying, rather than filling the disk part way.
function roomFor(directory, bytes) {
	let free;
	try {
		const disk = fs.statfsSync(directory);
		free = disk.bavail * disk.bsize;
	} catch {
		return;
	}
	// Room for the copy, and for the -wal SQLite keeps beside it while it is used.
	if (free < bytes * 1.05 + 100e6) {
		throw new Error(
			`Not enough free space: the copy needs ${(bytes / 1e9).toFixed(1)} GB, the disk has ${(free / 1e9).toFixed(1)} GB.`,
		);
	}
}

function removeGroup(file) {
	for (const suffix of ['', '-wal', '-shm', '-journal']) {
		try {
			fs.rmSync(`${file}${suffix}`, { force: true });
		} catch {
			// Locked: left behind, and harmless.
		}
	}
}

function samePath(a, b) {
	const one = path.resolve(a ?? '');
	const two = path.resolve(b ?? '');
	return process.platform === 'win32' ? one.toLowerCase() === two.toLowerCase() : one === two;
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

function diskSize(index) {
	let bytes = 0;
	for (const suffix of ['', '-wal']) {
		try {
			bytes += fs.statSync(`${index}${suffix}`).size;
		} catch {
			// Not there yet, or already gone.
		}
	}
	return bytes;
}

function card(entry) {
	const sources = sourcesOf(entry);
	return {
		id: entry.id,
		name: entry.name,
		path: sources[0]?.path ?? '',
		games: entry.games,
		positions: entry.positions,
		maxPly: entry.maxPly,
		// The database's own file: once a PGN is read, its games are kept here and the PGN is not needed.
		location: entry.index,
		bytes: diskSize(entry.index),
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
