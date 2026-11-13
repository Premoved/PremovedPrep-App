'use strict';

const crypto = require('node:crypto');

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

// The first three serve player lookups and date bounds; the rest let a sorted page stop early.
const GAME_INDEXES = [
	['game_white_key', 'game (whiteKey)'],
	['game_black_key', 'game (blackKey)'],
	['game_played', 'game (playedOn, year)'],
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
};
