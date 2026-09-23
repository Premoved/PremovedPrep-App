import { ItemShape, ItemType } from '../models/collection.model';

// Reads tags and counts the mainline for list columns; client-side because entries are encrypted.
export type PgnTags = Readonly<Record<string, string>>;

export interface PgnGame {
	readonly pgn: string;
	readonly tags: PgnTags;
	readonly plyCount: number;
}

export interface DerivedFields {
	readonly title: string | null;
	readonly author: string | null;
	readonly white: string | null;
	readonly whiteElo: number | null;
	readonly black: string | null;
	readonly blackElo: number | null;
	readonly result: string | null;
	readonly event: string | null;
	readonly date: string | null;
	readonly year: number | null;
	readonly eco: string | null;
	readonly plyCount: number;
	readonly startFen: string | null;
}

const TAG_PAIR = /^\s*\[\s*(\w+)\s+"((?:[^"\\]|\\.)*)"\s*]\s*$/;

const UNNAMED = new Set(['nn', 'n.n.', 'n.n', 'unknown', 'unknown player', 'anonymous']);

const STANDARD_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Splits on either signal a new game can start with: a tag pair after movetext has been seen, or a
// tag pair after the roster was closed by a blank line. Exporters disagree on which they emit.
export function splitPgn(text: string): PgnGame[] {
	const games: PgnGame[] = [];
	let block: string[] = [];

	let seenMovetext = false;
	let inTags = false;
	let tagsClosed = false;

	const flush = (): void => {
		const joined = block.join('\n').trim();
		if (joined.length > 0) {
			games.push(parsePgn(joined));
		}
	};

	for (const line of strip(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
		const isTag = TAG_PAIR.test(line);

		if (isTag && (seenMovetext || tagsClosed)) {
			flush();
			block = [];
			seenMovetext = false;
			tagsClosed = false;
		}

		if (isTag) {
			inTags = true;
		} else if (line.trim().length === 0) {
			tagsClosed = tagsClosed || inTags;
		} else {
			seenMovetext = true;
			inTags = false;
		}
		block.push(line);
	}
	flush();

	return games;
}

export function parsePgn(text: string): PgnGame {
	const pgn = strip(text);
	const tags: Record<string, string> = {};

	for (const line of pgn.split(/\r?\n/)) {
		const match = TAG_PAIR.exec(line);
		if (match) {
			tags[match[1]] = unescapeTag(match[2]);
		}
	}

	return { pgn: pgn.trim(), tags, plyCount: mainlineSan(pgn).length };
}

export function deriveFields(
	type: ItemType,
	game: PgnGame,
	title?: string | null,
	author?: string | null,
): DerivedFields {
	const startFen = startFenFor(type, game);
	const annotator = blankToNull(author ?? tag(game, 'Annotator'));

	if (shapeOf(type) === 'DOCUMENT') {
		return {
			title: blankToNull(title ?? tag(game, 'Event')),
			author: annotator,
			white: null,
			whiteElo: null,
			black: null,
			blackElo: null,
			result: null,
			event: null,
			date: null,
			year: null,
			eco: ecoFor(game),
			plyCount: game.plyCount,
			startFen,
		};
	}

	const dateTag = tag(game, 'Date');
	const isoDate = parseDate(dateTag);

	return {
		title: null,
		author: annotator,
		white: tag(game, 'White'),
		whiteElo: intTag(game, 'WhiteElo'),
		black: tag(game, 'Black'),
		blackElo: intTag(game, 'BlackElo'),
		result: resultToken(tag(game, 'Result')),
		event: tag(game, 'Event'),
		date: isoDate,
		year: isoDate !== null ? Number(isoDate.slice(0, 4)) : parseYear(dateTag),
		eco: ecoFor(game),
		plyCount: game.plyCount,
		startFen,
	};
}

export function importTypeFor(kind: 'LIBRARY' | 'REPERTOIRE', game: PgnGame): ItemType {
	const played = isNamed(tag(game, 'White')) && isNamed(tag(game, 'Black'));

	if (kind === 'REPERTOIRE') {
		return played ? 'MODEL_GAME' : 'MAIN_LINE';
	}
	if (played) {
		return 'GAME';
	}
	return tag(game, 'FEN') !== null ? 'STUDY' : 'ANALYSIS';
}

// Decided client-side: the server cannot see the starting position.
export function convertTypeTo(kind: 'LIBRARY' | 'REPERTOIRE', type: ItemType, startFen: string | null): ItemType {
	if (accepts(kind, type)) {
		return type;
	}
	switch (type) {
		case 'GAME':
			return 'MODEL_GAME';
		case 'MODEL_GAME':
			return 'GAME';
		case 'ANALYSIS':
		case 'STUDY':
			return 'MAIN_LINE';
		case 'MAIN_LINE':
			return startFen !== null ? 'STUDY' : 'ANALYSIS';
	}
}

export function accepts(kind: 'LIBRARY' | 'REPERTOIRE', type: ItemType): boolean {
	return kind === 'LIBRARY'
		? type === 'ANALYSIS' || type === 'STUDY' || type === 'GAME'
		: type === 'MAIN_LINE' || type === 'MODEL_GAME';
}

export function shapeOf(type: ItemType): ItemShape {
	return type === 'GAME' || type === 'MODEL_GAME' ? 'GAME' : 'DOCUMENT';
}

// Approximate SAN token count, by regex rather than replaying the game on a board: cheap enough to
// run for every entry in a folder, which actually replaying each one would not be.
export function mainlineSan(pgn: string): string[] {
	let text = pgn
		.replace(/\{[^}]*}/g, ' ')
		.replace(/;[^\n]*/g, ' ')
		.replace(/^[ \t]*\[[^\]]*][ \t]*$/gm, ' ');

	text = stripVariations(text);

	text = text
		.replace(/\$\d+/g, ' ')
		.replace(/\d+\s*\.(\.\.)?/g, ' ')
		.replace(/(1-0|0-1|1\/2-1\/2|\*)/g, ' ')
		.replace(/[?!]+/g, '');

	const moves: string[] = [];
	for (const token of text.trim().split(/\s+/)) {
		if (/^[OoO0](-[OoO0]){1,2}[+#]?$/.test(token) || /^[A-Za-z][A-Za-z0-9=+#-]*\d[A-Za-z0-9=+#]*$/.test(token)) {
			moves.push(token);
		}
	}
	return moves;
}

// From the file's own ECO tag only, deliberately: classifying an untagged line would mean sending
// its moves to the server for lookup, and those moves are exactly what encryption is protecting.
function ecoFor(game: PgnGame): string | null {
	const tagged = tag(game, 'ECO');
	return tagged === null ? null : tagged.slice(0, 3);
}

// Only a STUDY must carry a starting position.
export function startFenFor(type: ItemType, game: PgnGame): string | null {
	const fen = tag(game, 'FEN');

	if (type === 'ANALYSIS') {
		return null;
	}
	if (type === 'STUDY') {
		return fen ?? STANDARD_START;
	}
	return fen;
}

export function tag(game: PgnGame, name: string): string | null {
	const value = game.tags[name];
	if (value === undefined || value.trim().length === 0) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === '?' ? null : trimmed;
}

function intTag(game: PgnGame, name: string): number | null {
	const value = tag(game, name);
	if (value === null) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? null : parsed;
}

function resultToken(value: string | null): string | null {
	switch (value) {
		case '1-0':
		case '0-1':
		case '1/2-1/2':
			return value;
		case '*':
			return '*';
		default:
			return null;
	}
}

function parseDate(value: string | null): string | null {
	if (value === null || value.length < 10 || value.includes('?')) {
		return null;
	}
	const iso = value.slice(0, 10).replace(/\./g, '-');
	return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso)) ? iso : null;
}

function parseYear(value: string | null): number | null {
	if (value === null || value.length < 4) {
		return null;
	}
	const year = Number.parseInt(value.slice(0, 4), 10);
	return year > 1000 && year < 3000 ? year : null;
}

function isNamed(name: string | null): boolean {
	if (name === null || name.trim().length === 0) {
		return false;
	}
	const folded = name.trim().toLowerCase();
	return !UNNAMED.has(folded) && /\p{L}/u.test(folded);
}

function stripVariations(text: string): string {
	let out = '';
	let depth = 0;

	for (const character of text) {
		if (character === '(') {
			depth++;
		} else if (character === ')') {
			depth = Math.max(0, depth - 1); // an unbalanced ')' is a broken file, not a reason to go negative
		} else if (depth === 0) {
			out += character;
		}
	}
	return out;
}

// PGN escapes only \" and \\ inside a tag value.
function unescapeTag(value: string): string {
	return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function strip(pgn: string): string {
	return pgn.includes('\uFEFF') ? pgn.replace(/\uFEFF/g, '') : pgn;
}

function blankToNull(value: string | null | undefined): string | null {
	return value === null || value === undefined || value.trim().length === 0 ? null : value.trim();
}
