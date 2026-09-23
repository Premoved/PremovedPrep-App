'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'local-resources.json';

const EMPTY = {
	storageParent: null,
	engines: [],
	databases: [],
	nextEngineId: 1,
	nextDatabaseId: 1,
};

const RENAME_ATTEMPTS = 3;

const RENAME_RETRY_DELAY_MS = 50;

// EPERM/EBUSY: Windows antivirus or cloud sync briefly locking a just-written file. ENOENT: the
// source vanished from under this rename.
const RETRYABLE_RENAME_CODES = new Set(['ENOENT', 'EPERM', 'EBUSY']);

// Blocks this call only; settings are written from the main process at a handful of moments.
function sleep(ms) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		// Busy wait: fs here is synchronous and the delay is tens of milliseconds.
	}
}

function renameWithRetries(from, to) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (error) {
			if (attempt >= RENAME_ATTEMPTS || !RETRYABLE_RENAME_CODES.has(error.code)) {
				throw error;
			}
			sleep(RENAME_RETRY_DELAY_MS);
		}
	}
}

class Settings {
	constructor(directory) {
		this.path = path.join(directory, FILE);
		this.value = this.read();
	}

	read() {
		for (const file of [this.path, `${this.path}.previous`]) {
			try {
				const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
				return { ...EMPTY, ...parsed };
			} catch {
				// Missing or corrupt: fall back to defaults.
			}
		}
		return { ...EMPTY };
	}

	// Written beside the file and renamed over it, so a write cut short never leaves a half-written file.
	save() {
		fs.mkdirSync(path.dirname(this.path), { recursive: true });
		const next = `${this.path}.next`;
		const text = `${JSON.stringify(this.value, null, '\t')}\n`;
		fs.writeFileSync(next, text, 'utf8');
		try {
			fs.copyFileSync(this.path, `${this.path}.previous`);
		} catch {
			// Backup is best effort.
		}
		try {
			renameWithRetries(next, this.path);
		} catch (error) {
			// One more temp file and one more rename; writing the target directly would risk
			// truncating good settings for a write that may fail the same way.
			const retry = `${this.path}.${Date.now()}.next`;
			fs.writeFileSync(retry, text, 'utf8');
			try {
				renameWithRetries(retry, this.path);
			} catch {
				fs.rmSync(retry, { force: true });
				fs.rmSync(next, { force: true });
				throw error;
			}
			fs.rmSync(next, { force: true });
		}
	}

	update(patch) {
		this.value = { ...this.value, ...patch };
		this.save();
		return this.value;
	}

	takeEngineId() {
		const id = this.value.nextEngineId;
		this.update({ nextEngineId: id + 1 });
		return id;
	}

	takeDatabaseId() {
		const id = this.value.nextDatabaseId;
		this.update({ nextDatabaseId: id + 1 });
		return id;
	}
}

module.exports = { Settings };
