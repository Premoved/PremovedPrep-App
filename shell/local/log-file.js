'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The application's logs, kept on this computer only, for finding out what went wrong.
// Past MAX_BYTES a log becomes <name>.old.log, replacing the one before, so a log never takes much
// more than twice that. Paths in the user's own folder are written from ~ (~\Downloads\games.pgn),
// without the account name.

const MAX_BYTES = 1024 * 1024;

function homePattern() {
	const home = os.homedir();
	if (!home) {
		return null;
	}
	// Either kind of slash, and on Windows any case; not when the name runs on (C:\Users\ann in C:\Users\anna).
	const escaped = home
		.replace(/[\\/]+$/, '')
		.split(/[\\/]+/)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('[\\\\/]');
	return new RegExp(`${escaped}(?![^\\\\/\\s"'\`,;:)\\]])`, process.platform === 'win32' ? 'gi' : 'g');
}

const HOME = homePattern();

function withoutHome(text) {
	return HOME ? text.replace(HOME, '~') : text;
}

function oldLog(file) {
	const extension = path.extname(file);
	return path.join(path.dirname(file), `${path.basename(file, extension)}.old${extension}`);
}

function rotate(file) {
	let size;
	try {
		size = fs.statSync(file).size;
	} catch {
		return;
	}
	if (size >= MAX_BYTES) {
		fs.rmSync(oldLog(file), { force: true });
		fs.renameSync(file, oldLog(file));
	}
}

// Best effort: a log that cannot be written must not stop what it describes.
function appendLog(file, line) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		rotate(file);
		fs.appendFileSync(file, `${withoutHome(line)}\n`);
	} catch {
		// Logging is best effort.
	}
}

module.exports = { appendLog, withoutHome, MAX_BYTES };
