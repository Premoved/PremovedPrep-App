'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const BUCKETS = 256;

const hex = (bucket) => bucket.toString(16).padStart(2, '0');
const heapOf = (bucket) => `posh_${hex(bucket)}`;
const positionsOf = (bucket) => `pos_${hex(bucket)}`;
const treeOf = (bucket) => `tree_${hex(bucket)}`;

/** Excludes move counters, so any order to the same position shares a key; changing it invalidates every index. */
function keyOf(fen) {
	const fields = fen.trim().split(/\s+/).slice(0, 4).join(' ');
	return crypto.createHash('sha1').update(fields).digest().subarray(0, 12);
}

// The first five serve player lookups and date bounds; the rest let a sorted page stop early.
// The FIDE id ones hold only the games that carry an id: an archive without any costs nothing.
const GAME_INDEXES = [
	['game_white_key', 'game (whiteKey)'],
	['game_black_key', 'game (blackKey)'],
	['game_played', 'game (playedOn, year)'],
	['game_white_fide', 'game (whiteFideId) WHERE whiteFideId IS NOT NULL'],
	['game_black_fide', 'game (blackFideId) WHERE blackFideId IS NOT NULL'],
	['game_strength', 'game (strength)'],
	['game_white_elo', 'game (whiteElo)'],
	['game_black_elo', 'game (blackElo)'],
	['game_white', 'game (white)'],
	['game_black', 'game (black)'],
	['game_date', 'game (date)'],
	['game_event', 'game (event)'],
	['game_result', 'game (result)'],
	['game_eco', 'game (eco)'],
	['game_plies', 'game (plyCount)'],
];

const LABEL_PLAYER = 0;
const LABEL_EVENT = 1;

// Distinct player names and events, so a name typed in part is matched against a few hundred
// thousand labels instead of every game. fold is the name as it is searched: see fold().
const LABEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS label (
	id INTEGER PRIMARY KEY,
	kind INTEGER NOT NULL,
	name TEXT NOT NULL,
	games INTEGER NOT NULL,
	topElo INTEGER,
	fold TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS label_name ON label (kind, name);
`;

const LABEL_TEXT = `CREATE VIRTUAL TABLE IF NOT EXISTS label_text USING fts5(fold, content='label', content_rowid='id', tokenize='trigram')`;

const META_SCHEMA = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value) WITHOUT ROWID`;

// Raised when the label tables change shape: an index with another value has its name list built again.
const LABEL_LAYOUT = 2;

const FOLDED = { ø: 'o', ł: 'l', đ: 'd', ð: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i', þ: 'th' };

/** Lower case, without diacritics: "Öztürk" and "ozturk" fold to the same text. */
function fold(text) {
	return text
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[øłđðßæœıþ]/g, (letter) => FOLDED[letter]);
}

/**
 * The folded, order-independent form of a player's name, so a player is found by identity rather
 * than by spelling: "Carlsen, Magnus" and "Magnus Carlsen" both give "carlsen|magnus". Words of
 * one or two letters are left out, initials among them. Must stay exactly PlayerNameKey.of on the
 * server: the keys a search is given come from the server's player table and the two have to meet.
 */
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

/** A WhiteFideId or BlackFideId tag as the id it names; null when absent, 0 or not a number, as on the server. */
function fideIdOf(value) {
	if (typeof value !== 'string' || !/^\s*[+-]?\d+\s*$/.test(value)) {
		return null;
	}
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// The text of every game, compressed, so the database needs nothing but its own file once a PGN is
// imported. One table apart from game: scans of game stay as fast as without it.
const TEXT_SCHEMA = `CREATE TABLE IF NOT EXISTS gametext (id INTEGER PRIMARY KEY, body BLOB NOT NULL)`;

// First byte of every body. A new format gets a new number; old bodies stay readable.
const TEXT_DEFLATE_1 = 1;

// Primes the compressor with what every game shares, which plain deflate cannot learn from one
// short game. Never edited: bodies written with it are read with it. Later text compresses best.
const TEXT_DICTIONARY_1 = Buffer.from(
	[
		'[Annotator "',
		'[TimeControl "',
		'[EventDate "',
		'[PlyCount "',
		'[WhiteFideId "',
		'[BlackFideId "',
		'[WhiteTitle "GM"]',
		'[BlackTitle "IM"]',
		'[WhiteTeam "',
		'[Variant "',
		'[SetUp "1"]\n[FEN "',
		' {[%clk 0:',
		' {[%eval ',
		'1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 7. Nb3 Be6 8. f3 Be7 9. Qd2 O-O 10. O-O-O Nbd7 11. g4 b5 12. g5 ',
		'1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 Be7 5. Bf4 O-O 6. e3 c5 7. dxc5 Bxc5 8. Qc2 Nc6 9. a3 Qa5 10. Rd1 Re8 11. Nd2 e5 12. Bg5 ',
		'1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Na5 10. Bc2 c5 11. d4 Qc7 12. Nbd2 ',
		'1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4 5. a4 Bf5 6. e3 e6 7. Bxc4 Bb4 8. O-O Nbd7 9. Qe2 Bg6 10. e4 O-O 11. Bd3 Bh5 12. e5 ',
		'13. 14. 15. 16. 17. 18. 19. 20. 21. 22. 23. 24. 25. 26. 27. 28. 29. 30. 31. 32. 33. 34. 35. 36. 37. 38. 39. 40. ',
		'Nxe5 Nxd4 Bxf6 Qxd8 Rxd8 Rxe8+ Kh1 Kg8 Kf8 Kf1 Qh5 Rfe1 Rad1 Rac1 Rfd8 Rab8 Bxe4 Nxe4 dxe5 exd5 cxd5 axb5 ',
		'[Event "',
		'"]\n[Site "',
		'"]\n[Date "',
		'"]\n[Round "',
		'"]\n[White "',
		'"]\n[Black "',
		'"]\n[Result "1/2-1/2"]\n[Result "0-1"]\n[Result "1-0',
		'"]\n[WhiteElo "2',
		'"]\n[BlackElo "2',
		'"]\n[ECO "',
		'"]\n\n1. ',
		' 1/2-1/2',
		' 0-1',
		' 1-0',
	].join(''),
	'utf8',
);

/** A game's text as stored in gametext.body. */
function packText(text) {
	const packed = zlib.deflateRawSync(Buffer.from(text, 'utf8'), { dictionary: TEXT_DICTIONARY_1 });
	const body = Buffer.allocUnsafe(packed.length + 1);
	body[0] = TEXT_DEFLATE_1;
	packed.copy(body, 1);
	return body;
}

function unpackText(body) {
	const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	if (bytes[0] !== TEXT_DEFLATE_1) {
		throw new Error(`Game text stored in an unknown format (${bytes[0]}). Update the application.`);
	}
	return zlib.inflateRawSync(bytes.subarray(1), { dictionary: TEXT_DICTIONARY_1 }).toString('utf8');
}

module.exports = {
	BUCKETS,
	heapOf,
	positionsOf,
	treeOf,
	keyOf,
	GAME_INDEXES,
	LABEL_PLAYER,
	LABEL_EVENT,
	LABEL_SCHEMA,
	LABEL_TEXT,
	LABEL_LAYOUT,
	META_SCHEMA,
	fold,
	nameKey,
	fideIdOf,
	TEXT_SCHEMA,
	packText,
	unpackText,
};
