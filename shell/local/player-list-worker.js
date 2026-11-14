'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const { fold } = require('./layout');

// The format of the list the server sends (PlayerListExport.FORMAT).
const FORMAT = 1;

const BATCH = 20_000;

const SCHEMA = `
CREATE TABLE player (
	fideId INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	fold TEXT NOT NULL,
	federation TEXT,
	sex TEXT,
	title TEXT,
	wTitle TEXT,
	oTitle TEXT,
	foaTitle TEXT,
	standardRating INTEGER,
	standardGames INTEGER,
	rapidRating INTEGER,
	rapidGames INTEGER,
	blitzRating INTEGER,
	blitzGames INTEGER,
	birthYear INTEGER,
	active INTEGER NOT NULL,
	worldActive INTEGER,
	worldAll INTEGER,
	nationalActive INTEGER,
	nationalAll INTEGER
);
CREATE INDEX player_rating ON player (standardRating DESC, name);
CREATE TABLE alias (fideId INTEGER NOT NULL, name TEXT NOT NULL);
CREATE INDEX alias_fide ON alias (fideId);
CREATE TABLE meta (key TEXT PRIMARY KEY, value) WITHOUT ROWID;
`;

/**
 * Downloads the server's player list and builds the offline copy from it, in a file of its own: the
 * one in use is replaced only once this one is whole.
 */
async function build({ url, target, version }) {
	fs.rmSync(target, { force: true });
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`The player list could not be downloaded (HTTP ${response.status}).`);
	}
	const input = Readable.fromWeb(response.body).pipe(zlib.createGunzip());
	const lines = readline.createInterface({ input, crlfDelay: Infinity });

	const db = new DatabaseSync(target);
	try {
		db.exec('PRAGMA journal_mode = OFF');
		db.exec('PRAGMA synchronous = OFF');
		db.exec(SCHEMA);
		const addPlayer = db.prepare(
			`INSERT OR REPLACE INTO player VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const addAlias = db.prepare('INSERT INTO alias (fideId, name) VALUES (?, ?)');

		let header = null;
		let players = 0;
		let aliases = 0;
		let pending = 0;
		db.exec('BEGIN');
		for await (const line of lines) {
			if (header === null) {
				const [mark, format, listed] = line.split('\t');
				if (mark !== '#premovedprep-players' || Number(format) !== FORMAT) {
					throw new Error('The player list is in a format this version does not read. Update the application.');
				}
				header = listed;
				continue;
			}
			if (line.length === 0) continue;
			const fields = line.split('\t');
			if (fields[0] === 'P' && fields.length >= 21) {
				const value = (at) => (fields[at] === '' ? null : fields[at]);
				const number = (at) => (fields[at] === '' ? null : Number(fields[at]));
				addPlayer.run(
					Number(fields[1]),
					fields[2],
					fold(fields[2]),
					value(3),
					value(4),
					value(5),
					value(6),
					value(7),
					value(8),
					number(9),
					number(10),
					number(11),
					number(12),
					number(13),
					number(14),
					number(15),
					fields[16] === '1' ? 1 : 0,
					number(17),
					number(18),
					number(19),
					number(20),
				);
				players++;
			} else if (fields[0] === 'A' && fields.length >= 3 && fields[2] !== '') {
				addAlias.run(Number(fields[1]), fields[2]);
				aliases++;
			} else {
				continue;
			}
			if (++pending === BATCH) {
				db.exec('COMMIT');
				db.exec('BEGIN');
				pending = 0;
				parentPort?.postMessage({ type: 'progress', players });
			}
		}
		db.exec('COMMIT');
		if (header === null || players === 0) {
			throw new Error('The player list arrived empty.');
		}

		// detail='none': a fifth smaller, and LIKE is checked against the name itself anyway.
		db.exec(
			`CREATE VIRTUAL TABLE player_text USING fts5(fold, content='player', content_rowid='fideId', tokenize='trigram', detail='none')`,
		);
		db.exec(`INSERT INTO player_text (player_text) VALUES ('rebuild')`);
		const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
		setMeta.run('version', header || version);
		setMeta.run('format', FORMAT);
		setMeta.run('players', players);
		setMeta.run('aliases', aliases);
		setMeta.run('builtAt', new Date().toISOString());
		db.exec('ANALYZE');
		return { version: header || version, players, aliases };
	} finally {
		db.close();
	}
}

if (parentPort) {
	build(workerData).then(
		(built) => parentPort.postMessage({ type: 'done', ...built }),
		(error) => parentPort.postMessage({ type: 'failed', message: error.message }),
	);
}

module.exports = { build, FORMAT };
