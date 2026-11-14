'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const { QueryPool } = require('./query-pool');
const { unpacked } = require('./asar');
const { FORMAT } = require('./player-list-worker');

const NO_LIST =
	'The player list for working offline has not been downloaded yet. Connect to the internet once and it ' +
	'downloads by itself.';

// Next to the databases: in Local AppData on Windows, as the large files the app makes.
function playersFolder(userData) {
	if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
		return path.join(process.env.LOCALAPPDATA, 'PremovedPrep', 'Players');
	}
	return path.join(userData, 'players');
}

/**
 * The FIDE player list kept for working offline: Search opponent reads it when the server cannot
 * be reached. The server builds it after each monthly FIDE import; the app checks for a newer one
 * every time it checks for a newer version of itself, and replaces its copy only once the new one
 * is whole. Without a connection the last list it has is used, however old.
 */
class PlayerList {
	constructor(userData, emit) {
		this.folder = playersFolder(userData);
		this.file = path.join(this.folder, 'players.sqlite');
		this.emit = emit;
		this.updating = null;
		this.queries = new QueryPool(
			{ players: 10_000 },
			{ script: path.join(__dirname, 'player-query-worker.js'), log: (text) => this.log(text) },
		);
	}

	/** The list kept, or null: { version, players, builtAt }. */
	status() {
		if (!fs.existsSync(this.file)) {
			return null;
		}
		try {
			const db = new DatabaseSync(this.file, { readOnly: true });
			try {
				const meta = new Map(
					db
						.prepare('SELECT key, value FROM meta')
						.all()
						.map((row) => [row.key, row.value]),
				);
				return {
					version: meta.get('version') ?? null,
					players: meta.get('players') ?? 0,
					builtAt: meta.get('builtAt') ?? null,
					updating: this.updating !== null,
				};
			} finally {
				db.close();
			}
		} catch {
			return null;
		}
	}

	/** Starts fetching the server's list when it is newer than the one kept; returns at once. */
	update({ version, url, format } = {}) {
		if (typeof version !== 'string' || typeof url !== 'string' || !/^https?:\/\//.test(url) || format !== FORMAT) {
			return this.status();
		}
		const kept = this.status();
		if (this.updating === null && kept?.version !== version) {
			this.updating = this.download(url, version).finally(() => {
				this.updating = null;
			});
		}
		return this.status();
	}

	async download(url, version) {
		fs.mkdirSync(this.folder, { recursive: true });
		const next = `${this.file}.new`;
		const started = Date.now();
		try {
			const built = await new Promise((resolve, reject) => {
				const worker = new Worker(unpacked(path.join(__dirname, 'player-list-worker.js')), {
					workerData: { url, target: next, version },
				});
				let answered = false;
				worker.on('message', (message) => {
					if (message.type === 'done') {
						answered = true;
						resolve(message);
					} else if (message.type === 'failed') {
						answered = true;
						reject(new Error(message.message));
					}
				});
				worker.on('error', (error) => {
					answered = true;
					reject(error);
				});
				worker.on('exit', (code) => {
					if (!answered) reject(new Error(`The player list worker stopped (${code}).`));
				});
			});
			// Readers let go of the old file before it is replaced.
			await this.queries.release(this.file);
			fs.rmSync(this.file, { force: true });
			fs.renameSync(next, this.file);
			this.log(
				`player list ${built.version}: ${built.players} players in ${Math.round((Date.now() - started) / 1000)} s`,
			);
			this.emit('players.changed', this.status());
		} catch (error) {
			fs.rmSync(next, { force: true });
			this.log(`player list ${version} not updated: ${error.message}`);
		}
	}

	search(q, limit, channel) {
		return this.ask('search', { q, limit }, channel);
	}

	profile(fideId) {
		return this.ask('profile', { fideId });
	}

	identity(fideId) {
		return this.ask('identity', { fideId });
	}

	ask(method, args, channel) {
		if (!fs.existsSync(this.file)) {
			return Promise.reject(Object.assign(new Error(NO_LIST), { code: 'NOT_FOUND' }));
		}
		return this.queries.request('players', this.file, method, args, channel ?? null);
	}

	close() {
		this.queries.close();
	}

	log(text) {
		try {
			fs.mkdirSync(this.folder, { recursive: true });
			fs.appendFileSync(path.join(this.folder, 'players.log'), `${new Date().toISOString()} ${text}\n`);
		} catch {
			// Logging is best effort.
		}
	}
}

module.exports = { PlayerList, playersFolder };
