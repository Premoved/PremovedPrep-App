'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { parseGames, toEntry, compose, convertTypeTo, typeFor, UID_TAG, TYPE_TAG } = require('./pgn');

const ROOT_NAME = 'PremovedPrep';

const DEFAULT_ICON = 'folder';

const SIDECAR_SUFFIX = '.premovedprep.json';

const EMPTY_MAIN_LINE_PGN = `[Event "Main line"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]
[${TYPE_TAG} "MAIN_LINE"]

*
`;

class LocalStore {
	constructor(settings) {
		this.settings = settings;
		// Serialises writes, renames and removes so a save can never land between a rename's file
		// move and its sidecar move, or race another save's temp file.
		this.queue = Promise.resolve();
	}

	serialised(task) {
		const run = this.queue.then(task, task);
		this.queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	get parent() {
		return this.settings.value.storageParent;
	}

	location() {
		const parent = this.parent;
		if (!parent) {
			return { parent: null, root: null, library: null, white: null, black: null, exists: false };
		}
		const root = path.join(parent, ROOT_NAME);
		const repertoire = path.join(root, 'Repertoire');
		return {
			parent,
			root,
			library: path.join(root, 'Library'),
			white: path.join(repertoire, 'White'),
			black: path.join(repertoire, 'Black'),
			exists: fs.existsSync(root),
		};
	}

	ensure() {
		const at = this.location();
		if (!at.parent) {
			return at;
		}
		for (const directory of [at.root, at.library, at.white, at.black]) {
			fs.mkdirSync(directory, { recursive: true });
		}
		return this.location();
	}

	setParent(parent) {
		this.settings.update({ storageParent: parent });
		return this.ensure();
	}

	shelves() {
		const at = this.location();
		if (!at.parent) {
			return [];
		}
		return [
			{ kind: 'LIBRARY', color: null, directory: at.library },
			{ kind: 'REPERTOIRE', color: 'w', directory: at.white },
			{ kind: 'REPERTOIRE', color: 'b', directory: at.black },
		];
	}

	async shelf(kind, color) {
		const shelf = this.shelves().find((entry) => entry.kind === kind && entry.color === (color ?? null));
		if (!shelf) {
			return [];
		}

		let names;
		try {
			names = await fsp.readdir(shelf.directory);
		} catch {
			return [];
		}

		const collections = [];
		for (const name of names) {
			if (!name.toLowerCase().endsWith('.pgn')) {
				continue;
			}
			const file = path.join(shelf.directory, name);
			const stat = await fsp.stat(file).catch(() => null);
			if (!stat || !stat.isFile()) {
				continue;
			}
			const sidecar = await this.readSidecar(file);
			collections.push({
				id: collectionId(file),
				kind: shelf.kind,
				color: shelf.color,
				name: name.slice(0, -4),
				relativePath: path.relative(this.location().root, file),
				itemCount: await this.count(file),
				truncated: false,
				bytes: stat.size,
				updatedAt: stat.mtime.toISOString(),
				cloudId: sidecar && typeof sidecar.cloudId === 'number' ? sidecar.cloudId : null,
				uid: sidecar && typeof sidecar.uid === 'string' ? sidecar.uid : null,
				icon: sidecar && typeof sidecar.icon === 'string' ? sidecar.icon : DEFAULT_ICON,
				syncedDigest: sidecar && typeof sidecar.syncedDigest === 'string' ? sidecar.syncedDigest : null,
			});
		}
		return collections.sort((a, b) => a.name.localeCompare(b.name));
	}

	async placeOf(id) {
		for (const shelf of this.shelves()) {
			const names = await fsp.readdir(shelf.directory).catch(() => []);
			for (const name of names) {
				if (!name.toLowerCase().endsWith('.pgn')) {
					continue;
				}
				const file = path.join(shelf.directory, name);
				if (collectionId(file) === id) {
					return { file, shelf };
				}
			}
		}
		return null;
	}

	async fileFor(id) {
		const place = await this.placeOf(id);
		return place ? place.file : null;
	}

	async entries(id) {
		const place = await this.placeOf(id);
		if (!place) {
			return [];
		}
		const stat = await fsp.stat(place.file).catch(() => null);
		const text = await fsp.readFile(place.file, 'utf8').catch(() => '');
		const when = stat ? stat.mtime.toISOString() : null;
		return parseGames(text).map((game, index) => ({
			...toEntry(`${id}#${index}`, game, place.shelf.kind),
			updatedAt: when,
		}));
	}

	async details(id) {
		const place = await this.placeOf(id);
		if (!place) {
			return [];
		}
		const stat = await fsp.stat(place.file).catch(() => null);
		const text = await fsp.readFile(place.file, 'utf8').catch(() => '');
		const when = stat ? stat.mtime.toISOString() : null;
		const name = path.basename(place.file).slice(0, -4);

		return parseGames(text).map((game, index) => ({
			...toEntry(`${id}#${index}`, game, place.shelf.kind),
			updatedAt: when,
			collectionId: id,
			collectionName: name,
			pgn: compose(game.tags, game.movetext),
		}));
	}

	async entry(entryId) {
		const [id, at] = String(entryId).split('#');
		const index = Number(at);
		const place = await this.placeOf(id);
		if (!place || !Number.isInteger(index)) {
			return null;
		}
		const text = await fsp.readFile(place.file, 'utf8');
		const games = parseGames(text);
		const game = games[index];
		if (!game) {
			return null;
		}
		const stat = await fsp.stat(place.file).catch(() => null);
		return {
			...toEntry(entryId, game, place.shelf.kind),
			updatedAt: stat ? stat.mtime.toISOString() : null,
			collectionId: id,
			collectionName: path.basename(place.file).slice(0, -4),
			kind: place.shelf.kind,
			color: place.shelf.color,
			pgn: compose(game.tags, game.movetext),
		};
	}

	async count(file) {
		const text = await fsp.readFile(file, 'utf8').catch(() => '');
		return parseGames(text).length;
	}

	async createCollection(kind, color, name) {
		const shelf = this.shelves().find((entry) => entry.kind === kind && entry.color === (color ?? null));
		if (!shelf) {
			throw coded('BAD_REQUEST', 'No storage folder has been chosen on this computer');
		}

		const safe = fileName(name);
		const file = path.join(shelf.directory, `${safe}.pgn`);
		if (fs.existsSync(file)) {
			throw coded('BAD_REQUEST', `There is already a collection called ${safe} here`);
		}

		const contents = shelf.kind === 'REPERTOIRE' ? EMPTY_MAIN_LINE_PGN : '';
		await this.writeCollection(file, contents, {
			uid: crypto.randomUUID(),
			cloudId: null,
			syncedAt: null,
			icon: DEFAULT_ICON,
		});

		const stat = await fsp.stat(file).catch(() => null);
		return {
			id: collectionId(file),
			kind: shelf.kind,
			color: shelf.color,
			name: safe,
			relativePath: path.relative(this.location().root, file),
			itemCount: parseGames(contents).length,
			truncated: false,
			bytes: stat ? stat.size : 0,
			updatedAt: new Date().toISOString(),
			cloudId: null,
			uid: null,
			icon: DEFAULT_ICON,
		};
	}

	async read(id) {
		const file = await this.fileFor(id);
		return file ? fsp.readFile(file, 'utf8') : null;
	}

	async adopt({ kind, color, name, pgn, cloudId, uid, icon }) {
		const shelf = this.shelves().find((entry) => entry.kind === kind && entry.color === (color ?? null));
		if (!shelf) {
			throw coded('BAD_REQUEST', 'No storage folder has been chosen on this computer');
		}

		let file = path.join(shelf.directory, `${fileName(name)}.pgn`);
		for (let suffix = 2; fs.existsSync(file); suffix += 1) {
			file = path.join(shelf.directory, `${fileName(name)} (${suffix}).pgn`);
		}

		await this.writeCollection(file, withTrunk(kind, pgn ?? ''), {
			uid: uid ?? crypto.randomUUID(),
			cloudId: cloudId ?? null,
			syncedAt: new Date().toISOString(),
			icon: typeof icon === 'string' && icon.length > 0 ? icon : DEFAULT_ICON,
		});
		return {
			id: collectionId(file),
			name: path.basename(file).slice(0, -4),
			relativePath: path.relative(this.location().root, file),
		};
	}

	// Not a literal append: the file is read, extended and rewritten whole through writeCollection.
	async append(id, pgn, stamp = {}) {
		const place = await this.placeOf(id);
		if (!place) {
			throw coded('NOT_FOUND', 'That file is no longer in the folder');
		}
		const file = place.file;
		const existing = parseGames(await fsp.readFile(file, 'utf8'));
		const added = parseGames(String(pgn ?? '')).filter((game) => game.plies > 0 || Object.keys(game.tags).length > 0);
		if (added.length === 0) {
			throw coded('BAD_REQUEST', 'That file contains no games');
		}

		for (const game of added) {
			if (!game.tags[TYPE_TAG] && stamp.itemType) {
				game.tags[TYPE_TAG] = convertTypeTo(place.shelf.kind, stamp.itemType, game.tags['FEN']);
			}
			game.tags[TYPE_TAG] = typeFor(place.shelf.kind, game.tags);
			if (stamp.title && isUnknown(game.tags['Event'])) {
				game.tags['Event'] = stamp.title;
			}
		}

		await this.writeCollection(file, serialise([...existing, ...added]), await this.readSidecar(file));
		return { added: added.length, total: existing.length + added.length };
	}

	async replaceEntry(entryId, pgn) {
		const { file, index, games } = await this.locate(entryId);
		const replacement = parseGames(String(pgn ?? ''));
		if (replacement.length === 0) {
			throw coded('BAD_REQUEST', 'That is not a game');
		}
		const before = games[index].tags;
		for (const name of [UID_TAG, TYPE_TAG]) {
			if (!replacement[0].tags[name] && before[name]) {
				replacement[0].tags[name] = before[name];
			}
		}
		games.splice(index, 1, replacement[0]);
		await this.writeCollection(file, serialise(games), await this.readSidecar(file));
		return true;
	}

	async removeEntry(entryId) {
		const { file, index, games } = await this.locate(entryId);
		games.splice(index, 1);
		await this.writeCollection(file, serialise(games), await this.readSidecar(file));
		return true;
	}

	async locate(entryId) {
		const [id, at] = String(entryId).split('#');
		const index = Number(at);
		const file = await this.fileFor(id);
		if (!file || !Number.isInteger(index)) {
			throw coded('NOT_FOUND', 'That file is no longer in the folder');
		}
		const games = parseGames(await fsp.readFile(file, 'utf8'));
		if (index < 0 || index >= games.length) {
			throw coded('NOT_FOUND', 'That entry is no longer in the file');
		}
		return { file, index, games };
	}

	async write(id, pgn) {
		const file = await this.fileFor(id);
		if (!file) {
			throw coded('NOT_FOUND', 'That file is no longer in the folder');
		}
		await this.writeCollection(file, String(pgn ?? ''), await this.readSidecar(file));
		return true;
	}

	async markSynced(id, digest) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				throw coded('NOT_FOUND', 'That file is no longer in the folder');
			}
			const sidecar = (await this.readSidecar(file)) ?? { uid: crypto.randomUUID() };
			await this.writeSidecar(file, { ...sidecar, syncedDigest: digest ?? null, syncedAt: new Date().toISOString() });
			return true;
		});
	}

	// Serialised against writeCollection() and remove(): the file move and its sidecar move must
	// not interleave with a save that is reading or rewriting the same collection.
	async rename(id, name) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				throw coded('NOT_FOUND', 'That file is no longer in the folder');
			}
			const target = path.join(path.dirname(file), `${fileName(name)}.pgn`);
			if (target === file) {
				return { id, name: fileName(name) };
			}
			if (fs.existsSync(target)) {
				throw coded('BAD_REQUEST', `There is already a collection called ${fileName(name)} here`);
			}

			const sidecar = await this.readSidecar(file);
			await renameWithRetries(file, target);
			await fsp.rm(this.sidecarPath(file), { force: true });
			if (sidecar) {
				await this.writeSidecar(target, sidecar);
			}
			return { id: collectionId(target), name: fileName(name) };
		});
	}

	async remove(id) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				return false;
			}
			await fsp.rm(file, { force: true });
			await fsp.rm(this.sidecarPath(file), { force: true });
			return true;
		});
	}

	async setIcon(id, icon) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				throw coded('NOT_FOUND', 'That file is no longer in the folder');
			}
			const sidecar = (await this.readSidecar(file)) ?? { uid: crypto.randomUUID() };
			await this.writeSidecar(file, { ...sidecar, icon: typeof icon === 'string' && icon ? icon : DEFAULT_ICON });
			return true;
		});
	}

	async pair(id, cloudId) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				throw coded('NOT_FOUND', 'That file is no longer in the folder');
			}
			const sidecar = (await this.readSidecar(file)) ?? { uid: crypto.randomUUID() };
			await this.writeSidecar(file, {
				...sidecar,
				cloudId: cloudId ?? null,
				syncedDigest: null,
				syncedAt: new Date().toISOString(),
			});
			return true;
		});
	}

	sidecarPath(file) {
		return `${file.slice(0, -4)}${SIDECAR_SUFFIX}`;
	}

	async readSidecar(file) {
		try {
			return JSON.parse(await fsp.readFile(this.sidecarPath(file), 'utf8'));
		} catch {
			return null;
		}
	}

	async writeSidecar(file, value) {
		await fsp.writeFile(this.sidecarPath(file), `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
	}

	// Through a temporary file and a rename, atomic within a volume: an interrupted write leaves the
	// old version. Serialised against rename() and remove() on the same store.
	async writeCollection(file, pgn, sidecar) {
		return this.serialised(async () => {
			await fsp.mkdir(path.dirname(file), { recursive: true });
			// Random, not just the pid: two writes racing for the same file in one process must not
			// share a temp path, or one's rename can steal the other's temp file out from under it.
			const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
			await fsp.writeFile(temporary, pgn, 'utf8');
			try {
				await renameWithRetries(temporary, file);
			} catch (error) {
				// A second temp file and one more rename. Writing the target directly would risk
				// truncating the saved collection for a write that may fail the same way.
				const retry = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
				await fsp.writeFile(retry, pgn, 'utf8');
				try {
					await renameWithRetries(retry, file);
				} catch {
					await fsp.rm(retry, { force: true });
					await fsp.rm(temporary, { force: true });
					throw error;
				}
				await fsp.rm(temporary, { force: true });
			}
			if (sidecar) {
				await this.writeSidecar(file, sidecar);
			}
		});
	}
}

// Strips characters Windows forbids in a filename and trailing dots/spaces it silently drops.
function fileName(name) {
	const cleaned = String(name)
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.]+|[\s.]+$/g, '')
		.slice(0, 120);
	if (cleaned.length === 0) {
		return 'Untitled';
	}
	return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

function withTrunk(kind, pgn) {
	if (kind !== 'REPERTOIRE') {
		return pgn;
	}
	const games = parseGames(pgn);
	const hasTrunk = games.some((game) => typeFor('REPERTOIRE', game.tags) === 'MAIN_LINE');
	if (hasTrunk) {
		return pgn;
	}
	return games.length === 0 ? EMPTY_MAIN_LINE_PGN : `${EMPTY_MAIN_LINE_PGN}\n${pgn}`;
}

function serialise(games) {
	return games.map((game) => compose(game.tags, game.movetext)).join('\n');
}

function isUnknown(value) {
	const text = (value ?? '').trim();
	return text.length === 0 || /^[?*.\s-]*$/.test(text);
}

function coded(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

const RENAME_ATTEMPTS = 3;

const RENAME_RETRY_DELAY_MS = 50;

// EPERM/EBUSY: Windows antivirus or cloud sync (OneDrive, Dropbox) briefly locking a just-written
// file. ENOENT: the source vanished from under this rename.
const RETRYABLE_RENAME_CODES = new Set(['ENOENT', 'EPERM', 'EBUSY']);

async function renameWithRetries(from, to) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			await fsp.rename(from, to);
			return;
		} catch (error) {
			if (attempt >= RENAME_ATTEMPTS || !RETRYABLE_RENAME_CODES.has(error.code)) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
		}
	}
}

// Derived from the path, not stored: changes if the file is renamed.
function collectionId(file) {
	return crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
}

module.exports = { LocalStore, collectionId, UID_TAG };
