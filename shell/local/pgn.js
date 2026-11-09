'use strict';

const TAG = /^\s*\[\s*([A-Za-z0-9_]+)\s*"((?:[^"\\]|\\.)*)"\s*\]\s*$/;

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

const UID_TAG = 'PremovedUid';

const TYPE_TAG = 'PremovedType';

function parseGames(text) {
	const games = [];
	let tags = {};
	let moves = [];
	let started = false;
	let inMoves = false;

	const flush = () => {
		if (!started) {
			return;
		}
		games.push(finish(tags, moves));
		tags = {};
		moves = [];
		started = false;
		inMoves = false;
	};

	for (const line of text.split(/\r?\n/)) {
		const tag = TAG.exec(line);
		if (tag) {
			if (inMoves) {
				flush();
			}
			tags[tag[1]] = tag[2].replace(/\\(["\\])/g, '$1');
			started = true;
			continue;
		}
		if (line.trim().length > 0) {
			inMoves = true;
		}
		if (started) {
			moves.push(line);
		}
	}
	flush();
	return games;
}

function finish(tags, moves) {
	const movetext = moves.join('\n').trim();
	return { tags, movetext, plies: plyCount(movetext) };
}

function plyCount(movetext) {
	const bare = movetext
		.replace(/\{[^}]*\}/g, ' ')
		.replace(/;[^\n]*/g, ' ')
		.replace(/\([^()]*\)/g, ' ')
		.replace(/\$\d+/g, ' ')
		.replace(/\d+\s*\.(\.\.)?/g, ' ');

	let count = 0;
	for (const token of bare.split(/\s+/)) {
		if (token.length === 0 || RESULTS.has(token)) {
			continue;
		}
		count += 1;
	}
	return count;
}

function year(date) {
	const value = Number((date ?? '').slice(0, 4));
	return Number.isInteger(value) && value > 1000 ? value : null;
}

function number(value) {
	if (value === null || value === undefined || value === '') {
		return null;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function known(value) {
	const text = (value ?? '').trim();
	return text.length > 0 && !/^[?*.\s-]*$/.test(text) ? text : null;
}

// The type is a behaviour, not a shape: every entry is read with the same game columns.
const TYPES_BY_KIND = {
	LIBRARY: ['STUDY', 'GAME'],
	REPERTOIRE: ['MAIN_LINE', 'MODEL_GAME'],
};

const ALL_TYPES = ['STUDY', 'GAME', 'MAIN_LINE', 'MODEL_GAME'];

// ANALYSIS was merged into GAME; files written before that still carry it.
const RETIRED_TYPES = { ANALYSIS: 'GAME' };

const UNNAMED = new Set(['nn', 'n.n.', 'n.n', 'unknown', 'unknown player', 'anonymous']);

function isNamed(name) {
	if (name === null || name === undefined || String(name).trim().length === 0) {
		return false;
	}
	const folded = String(name).trim().toLowerCase();
	return !UNNAMED.has(folded) && /\p{L}/u.test(folded);
}

function accepts(kind, type) {
	return (TYPES_BY_KIND[kind] ?? TYPES_BY_KIND.LIBRARY).includes(type);
}

function importTypeFor(kind, tags) {
	// Both names, not either: one filled in alone is a fragment, not a played game.
	const played = isNamed(tags['White']) && isNamed(tags['Black']);

	if (kind === 'REPERTOIRE') {
		return played ? 'MODEL_GAME' : 'MAIN_LINE';
	}
	return !played && tags['FEN'] ? 'STUDY' : 'GAME';
}

// A pair each way, so moving an entry to the other shelf and back is lossless.
function convertTypeTo(kind, raw) {
	const type = RETIRED_TYPES[raw] ?? raw;
	if (accepts(kind, type)) {
		return type;
	}
	switch (type) {
		case 'GAME':
			return 'MODEL_GAME';
		case 'MODEL_GAME':
			return 'GAME';
		case 'STUDY':
			return 'MAIN_LINE';
		case 'MAIN_LINE':
			return 'STUDY';
		default:
			return importTypeFor(kind, {});
	}
}

function typeFor(kind, tags) {
	const declared = known(tags[TYPE_TAG]);
	if (declared && (ALL_TYPES.includes(declared) || declared in RETIRED_TYPES)) {
		return convertTypeTo(kind, declared);
	}
	return importTypeFor(kind, tags);
}

function toEntry(id, game, kind = 'LIBRARY') {
	const tags = game.tags;
	const white = known(tags['White']);
	const black = known(tags['Black']);
	const itemType = typeFor(kind, tags);

	return {
		id,
		uid: known(tags[UID_TAG]),
		itemType,
		white,
		whiteElo: number(known(tags['WhiteElo'])),
		black,
		blackElo: number(known(tags['BlackElo'])),
		result: known(tags['Result']),
		event: known(tags['Event']),
		date: known(tags['Date']),
		year: year(tags['Date']),
		annotator: known(tags['Annotator']),
		eco: known(tags['ECO']),
		plyCount: game.plies,
		startFen: known(tags['FEN']),
		updatedAt: null,
	};
}

// PGN's seven-tag roster first, in order; every other tag keeps its insertion order after it.
function compose(tags, movetext) {
	const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
	const names = [...order.filter((name) => name in tags), ...Object.keys(tags).filter((name) => !order.includes(name))];
	const head = names.map((name) => `[${name} "${String(tags[name]).replace(/([\\"])/g, '\\$1')}"]`).join('\n');
	return `${head}\n\n${movetext.trim()}\n`;
}

module.exports = {
	parseGames,
	plyCount,
	toEntry,
	compose,
	accepts,
	importTypeFor,
	convertTypeTo,
	typeFor,
	UID_TAG,
	TYPE_TAG,
};
