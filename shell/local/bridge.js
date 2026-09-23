'use strict';

const { dialog } = require('electron');

const NEEDS_WINDOW = new Set(['store.choose', 'engine.choose', 'db.choose', 'db.append']);

class Bridge {
	constructor({ settings, store, engines, databases, window }) {
		this.settings = settings;
		this.store = store;
		this.engines = engines;
		this.databases = databases;
		this.window = window;
	}

	async handle(method, params = {}) {
		const table = this.table();
		// Own properties only: guards against dispatching to constructor/toString on the table.
		const call = typeof method === 'string' && Object.hasOwn(table, method) ? table[method] : null;
		if (!call) {
			throw failure('UNKNOWN_METHOD', `No such method: ${method}`);
		}
		if (NEEDS_WINDOW.has(method) && !this.window()) {
			throw failure('FAILED', 'There is no window to open a chooser from');
		}
		return call(params);
	}

	table() {
		return {
			'agent.hello': () => this.hello(),

			'store.location': () => this.store.location(),
			'store.choose': () => this.chooseFolder(),

			'folder.shelf': ({ kind, color }) => this.store.shelf(kind, color ?? null),
			'folder.create': ({ kind, color, name }) => this.store.createCollection(kind, color ?? null, name),
			'folder.read': ({ collectionId }) => this.store.read(collectionId),
			'folder.adopt': (params) => this.store.adopt(params),
			'folder.rename': ({ collectionId, name }) => this.store.rename(collectionId, name),
			'folder.remove': ({ collectionId }) => this.store.remove(collectionId),
			'folder.pair': ({ collectionId, cloudId }) => this.store.pair(collectionId, cloudId ?? null),
			'folder.icon': ({ collectionId, icon }) => this.store.setIcon(collectionId, icon),
			'folder.write': ({ collectionId, pgn }) => this.store.write(collectionId, pgn),
			'folder.synced': ({ collectionId, digest }) => this.store.markSynced(collectionId, digest ?? null),
			'folder.append': ({ collectionId, pgn, itemType, title }) =>
				this.store.append(collectionId, pgn, { itemType, title }),
			'folder.entryReplace': ({ id, pgn }) => this.store.replaceEntry(id, pgn),
			'folder.entryRemove': ({ id }) => this.store.removeEntry(id),
			'folder.entries': ({ collectionId }) => this.store.entries(collectionId),
			'folder.details': ({ collectionId }) => this.store.details(collectionId),
			'folder.entry': async ({ id }) => {
				const entry = await this.store.entry(id);
				if (!entry) {
					throw failure('NOT_FOUND', 'That file is no longer in the folder');
				}
				return entry;
			},

			'engine.list': () => this.engines.list(),
			'engine.choose': () => this.chooseEngine(),
			'engine.remove': ({ engineId }) => {
				if (!this.engines.remove(engineId)) {
					throw failure('FAILED', 'The bundled engine cannot be removed.');
				}
				return this.engines.list();
			},
			'engine.open': ({ engineId }) => this.engines.open(engineId),
			'engine.send': ({ sessionId, command }) => {
				this.engines.send(sessionId, command);
				return true;
			},
			'engine.close': ({ sessionId }) => {
				this.engines.close(sessionId);
				return true;
			},

			'db.list': () => this.databases.list(),
			'db.choose': () => this.chooseDatabase(),
			'db.append': ({ databaseId }) => this.appendToDatabase(databaseId),
			// Returns once the worker starts; progress follows via db.progress events.
			'db.rebuild': ({ databaseId }) => {
				void this.databases.rebuild(databaseId).catch(() => undefined);
				return this.databases.list();
			},
			'db.resume': ({ databaseId }) => {
				void this.databases.resume(databaseId).catch(() => undefined);
				return this.databases.list();
			},
			'db.remove': ({ databaseId }) => {
				this.databases.remove(databaseId);
				return this.databases.list();
			},
			'db.cancel': ({ databaseId }) => this.databases.cancel(databaseId),
			'db.tree': ({ databaseId, fen }) => this.databases.tree(databaseId, fen),
			'db.players': ({ databaseId, q, limit }) => this.databases.players(databaseId, q, limit),
			'db.opponent': ({ databaseId, ...scope }) => this.databases.opponent(databaseId, scope),
			'db.opponentTree': ({ databaseId, ...scope }) => this.databases.opponentTree(databaseId, scope),
			'db.search': ({ databaseId, ...criteria }) => this.databases.search(databaseId, criteria),
			'db.games': ({ databaseId, fen, sort, ascending, page, size }) =>
				this.databases.games(databaseId, fen, sort, ascending === true, page ?? 0, size ?? 100),
			'db.game': async ({ databaseId, gameId }) => {
				const game = this.databases.game(databaseId, gameId);
				if (!game) {
					throw failure('NOT_FOUND', 'That game is no longer in the file.');
				}
				return game;
			},
		};
	}

	hello() {
		return {
			agent: 'PremovedPrep',
			version: this.settings.value.version ?? null,
			protocol: 1,
			paired: true,
			bridge: 'embedded',
		};
	}

	async chooseFolder() {
		const picked = await dialog.showOpenDialog(this.window(), {
			properties: ['openDirectory', 'createDirectory'],
		});
		if (picked.canceled || picked.filePaths.length === 0) {
			return this.store.location();
		}
		return this.store.setParent(picked.filePaths[0]);
	}

	async chooseDatabase() {
		const picked = await dialog.showOpenDialog(this.window(), {
			properties: ['openFile'],
			filters: [{ name: 'PGN', extensions: ['pgn'] }],
		});
		if (picked.canceled || picked.filePaths.length === 0) {
			return this.databases.list();
		}
		void this.databases.add(picked.filePaths[0], null).catch(() => undefined);
		return this.databases.list();
	}

	async appendToDatabase(databaseId) {
		const picked = await dialog.showOpenDialog(this.window(), {
			properties: ['openFile'],
			filters: [{ name: 'PGN', extensions: ['pgn'] }],
		});
		if (picked.canceled || picked.filePaths.length === 0) {
			return this.databases.list();
		}
		void this.databases.append(databaseId, picked.filePaths[0]).catch(() => undefined);
		return this.databases.list();
	}

	async chooseEngine() {
		const filters =
			process.platform === 'win32'
				? [{ name: 'Programs', extensions: ['exe'] }]
				: [{ name: 'Programs', extensions: ['*'] }];

		const picked = await dialog.showOpenDialog(this.window(), { properties: ['openFile'], filters });
		if (picked.canceled || picked.filePaths.length === 0) {
			return this.engines.list();
		}
		await this.engines.add(picked.filePaths[0], null);
		return this.engines.list();
	}
}

function failure(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

module.exports = { Bridge };
