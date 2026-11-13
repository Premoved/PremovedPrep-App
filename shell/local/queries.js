'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const { keyOf, positionsOf, treeOf, LABEL_PLAYER, LABEL_EVENT, LABEL_LAYOUT, fold } = require('./layout');
const { sanTokens } = require('./pgn-stream');

// Sort key -> column and the index that lists games in that order.
const POSITION_SORTS = {
	STRENGTH: ['g.strength', 'game_strength'],
	WHITE_NAME: ['g.white', 'game_white'],
	WHITE_ELO: ['g.whiteElo', 'game_white_elo'],
	RESULT: ['g.result', 'game_result'],
	BLACK_NAME: ['g.black', 'game_black'],
	BLACK_ELO: ['g.blackElo', 'game_black_elo'],
	DATE: ['g.date', 'game_date'],
	EVENT: ['g.event', 'game_event'],
};

const SEARCH_SORTS = {
	DATE: 'g.playedOn',
	STRENGTH: 'g.strength',
	WHITE_NAME: 'g.white',
	BLACK_NAME: 'g.black',
	WHITE_ELO: 'g.whiteElo',
	BLACK_ELO: 'g.blackElo',
	RESULT: 'g.result',
	EVENT: 'g.event',
	ECO: 'g.eco',
	MOVES: 'g.plyCount',
};

const SUMMARY = `g.id, g.white, g.whiteElo, g.black, g.blackElo, g.result, g.date, g.year, g.event, g.eco`;

const MAX_PAGE = 200;

// A probe that has read this many times the games at the position gives up for the direct query.
const PROBE_BUDGET = 4;
const PROBE_FLOOR = 20_000;

// The server's cap for the same report (AdvancedReportService.MAX_GAMES).
const REPORT_GAMES = 4000;

// Plies kept per game: the report never walks further than 60 (advanced-report.ts, MAX_PLY).
const REPORT_PLIES = 60;

const STANDARD_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** One read-only connection to an index, with what its schema offers, re-read when the schema changes. */
class Reader {
	constructor(index) {
		this.db = new DatabaseSync(index, { readOnly: true });
		this.db.exec('PRAGMA cache_size = -65536');
		this.db.exec('PRAGMA query_only = 1');
		this.version = null;
		this.known = null;
	}

	facts() {
		const version = this.db.prepare('PRAGMA schema_version').get().schema_version;
		if (version !== this.version) {
			const names = new Set(
				this.db
					.prepare('SELECT name FROM sqlite_master')
					.all()
					.map((row) => row.name),
			);
			this.known = {
				bucketed: names.has('pos_00'),
				indexes: names,
				meta: names.has('label') && names.has('meta'),
				text: names.has('label_text'),
			};
			this.version = version;
		}
		// Read every time: the name list is filled and marked in one transaction, with no schema change.
		this.known.labels = this.known.meta && this.labelsReady();
		this.known.totalGames = this.db.prepare('SELECT MAX(id) AS top FROM game').get().top ?? 0;
		return this.known;
	}

	labelsReady() {
		const marks = new Map(
			this.db
				.prepare(`SELECT key, value FROM meta WHERE key IN ('labelLayout', 'labelsUpTo')`)
				.all()
				.map((row) => [row.key, row.value]),
		);
		return marks.get('labelLayout') === LABEL_LAYOUT && marks.has('labelsUpTo');
	}

	close() {
		this.db.close();
	}
}

function tablesFor(facts, key) {
	return facts.bucketed
		? { positions: positionsOf(key[0]), tree: treeOf(key[0]) }
		: { positions: 'position', tree: 'tree' };
}

function tree(reader, { fen }) {
	const { db } = reader;
	const key = keyOf(fen);
	const tables = tablesFor(reader.facts(), key);

	let rows = db
		.prepare(
			`SELECT m.san AS san, m.uci AS uci, t.games AS games,
			        t.whiteWins AS whiteWins, t.draws AS draws, t.blackWins AS blackWins,
			        g.id AS topId, g.white AS topWhite, g.whiteElo AS topWhiteElo,
			        g.black AS topBlack, g.blackElo AS topBlackElo,
			        g.result AS topResult, g.year AS topYear, g.event AS topEvent
			 FROM ${tables.tree} t
			 JOIN move m ON m.id = t.moveId
			 LEFT JOIN game g ON g.id = t.topGameId
			 WHERE t.key = ?
			 ORDER BY t.games DESC, t.whiteWins DESC`,
		)
		.all(key);

	// A position only one game reached has no tree row; read its single row from positions instead.
	if (rows.length === 0) {
		rows = db
			.prepare(
				`SELECT m.san AS san, m.uci AS uci, 1 AS games,
				        (g.result = '1-0') AS whiteWins, (g.result = '1/2-1/2') AS draws, (g.result = '0-1') AS blackWins,
				        g.id AS topId, g.white AS topWhite, g.whiteElo AS topWhiteElo,
				        g.black AS topBlack, g.blackElo AS topBlackElo,
				        g.result AS topResult, g.year AS topYear, g.event AS topEvent
				 FROM ${tables.positions} p
				 JOIN move m ON m.id = p.moveId
				 JOIN game g ON g.id = p.gameId
				 WHERE p.key = ?`,
			)
			.all(key);
	}

	return summarise(
		fen,
		rows.map((row) => ({
			san: row.san,
			uci: row.uci,
			games: row.games,
			whiteWins: row.whiteWins,
			draws: row.draws,
			blackWins: row.blackWins,
			topGame:
				row.topId === null
					? null
					: {
							id: row.topId,
							white: row.topWhite,
							whiteElo: row.topWhiteElo,
							black: row.topBlack,
							blackElo: row.topBlackElo,
							result: row.topResult,
							year: row.topYear,
							event: row.topEvent,
							engine: false,
						},
		})),
	);
}

// Games at a position, one row per game. A popular position is read in the order of the sort's
// index, keeping the games that reached it, so the first page costs a few hundred lookups however
// many games share the position; a rare one is read whole and sorted.
function games(reader, { fen, sort, ascending, page, size }) {
	const { db } = reader;
	const facts = reader.facts();
	const key = keyOf(fen);
	const tables = tablesFor(facts, key);
	const [column, index] = POSITION_SORTS[sort] ?? POSITION_SORTS.STRENGTH;
	const direction = ascending ? 'ASC' : 'DESC';
	const limit = clamp(size, 1, MAX_PAGE, 100);
	const skip = clamp(page, 0, Number.MAX_SAFE_INTEGER, 0) * limit;
	const wanted = skip + limit + 1;

	let found = null;
	const reached = gamesAt(db, tables, key);
	if (facts.indexes.has(index) && reached > 0 && (wanted * facts.totalGames) / reached < reached) {
		found = probe(db, tables, key, column, index, direction, wanted, Math.max(reached * PROBE_BUDGET, PROBE_FLOOR));
	}

	let rows;
	if (found !== null) {
		const pageIds = found.slice(skip, skip + limit + 1);
		const details = byIds(
			db,
			`SELECT ${SUMMARY} FROM game g WHERE g.id IN`,
			pageIds.map((one) => one.id),
		);
		rows = pageIds.map((one) => ({ ...details.get(one.id), ply: one.ply }));
	} else {
		rows = db
			.prepare(
				`SELECT ${SUMMARY}, p.ply AS ply
				 FROM (SELECT gameId, MIN(ply) AS ply FROM ${tables.positions} WHERE key = ? GROUP BY gameId) p
				 JOIN game g ON g.id = p.gameId
				 ORDER BY ${column} ${direction} NULLS LAST, g.id ${direction}
				 LIMIT ? OFFSET ?`,
			)
			.all(key, limit + 1, skip);
	}

	return { fen, games: rows.slice(0, limit), hasMore: rows.length > limit };
}

// How many games reached the position, from the counted tree; a position with no tree row has at most one.
function gamesAt(db, tables, key) {
	const counted = db.prepare(`SELECT COALESCE(SUM(games), 0) AS n FROM ${tables.tree} WHERE key = ?`).get(key).n;
	if (counted > 0) {
		return counted;
	}
	return db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${tables.positions} WHERE key = ? LIMIT 2)`).get(key).n;
}

// Same order as the direct query: values in the sort's direction with NULLs last, ties by id.
function probe(db, tables, key, column, index, direction, wanted, budget) {
	const bare = column.slice(2);
	const reachedAt = db.prepare(`SELECT MIN(ply) AS ply FROM ${tables.positions} WHERE key = ? AND gameId = ?`);
	const passes = [
		`SELECT id FROM game INDEXED BY ${index} WHERE ${bare} IS NOT NULL ORDER BY ${bare} ${direction}, id ${direction}`,
		`SELECT id FROM game INDEXED BY ${index} WHERE ${bare} IS NULL ORDER BY id ${direction}`,
	];
	const found = [];
	let read = 0;
	for (const sql of passes) {
		const scan = db.prepare(sql);
		scan.setReturnArrays?.(true);
		const arrays = typeof scan.setReturnArrays === 'function';
		for (const row of scan.iterate()) {
			if (++read > budget) {
				return null;
			}
			const id = arrays ? row[0] : row.id;
			const ply = reachedAt.get(key, id).ply;
			if (ply !== null && ply !== undefined) {
				found.push({ id, ply });
				if (found.length >= wanted) {
					return found;
				}
			}
		}
	}
	return found;
}

function game(reader, { gameId }) {
	const row = reader.db
		.prepare(
			`SELECT g.id, g.white, g.whiteElo, g.black, g.blackElo, g.result, g.date, g.year, g.event, g.site,
			        g.round, g.eco, g.start, g.length, s.path AS file, s.bytes AS bytes
			 FROM game g JOIN source s ON s.id = g.sourceId
			 WHERE g.id = ?`,
		)
		.get(gameId);

	if (!row) {
		return null;
	}

	// The game text is never copied into the index; it is read back from its byte offset in the source PGN.
	const handles = new Files();
	try {
		const text = handles.read(row.file, row.bytes, row.start, row.length);
		const { start, length, file, bytes, ...rest } = row;
		return { ...rest, pgn: text.trim() };
	} finally {
		handles.close();
	}
}

function players(reader, { q, limit = 12 }) {
	const facts = reader.facts();
	const like = fragment(q ?? '');
	const count = Math.max(1, Math.min(Number(limit) || 12, 50));
	if (facts.labels) {
		return reader.db
			.prepare(
				`SELECT name, topElo FROM label
				 WHERE kind = ${LABEL_PLAYER} AND ${labelMatch(facts)}
				 ORDER BY topElo DESC NULLS LAST, name ASC
				 LIMIT ?`,
			)
			.all(like.folded, count);
	}
	return reader.db
		.prepare(
			`SELECT name, MAX(elo) AS topElo FROM (
			        SELECT white AS name, whiteElo AS elo FROM game WHERE lower(white) LIKE ?
			        UNION ALL
			        SELECT black AS name, blackElo AS elo FROM game WHERE lower(black) LIKE ?
			 )
			 GROUP BY name
			 ORDER BY topElo DESC NULLS LAST, name ASC
			 LIMIT ?`,
		)
		.all(like.lower, like.lower, count);
}

function opponent(reader, { nameKeys, color, from, to, sort, ascending, page, size }) {
	const side = color === 'b' ? 'blackKey' : 'whiteKey';
	const where = [];
	const args = [];

	if (Array.isArray(nameKeys) && nameKeys.length > 0) {
		where.push(`g.${side} IN (${nameKeys.map(() => '?').join(', ')})`);
		args.push(...nameKeys);
	} else {
		where.push('1 = 0');
	}

	dateBounds(where, args, from, to);
	return searchPage(reader, where, args, sort, ascending, page, size);
}

// What the Advanced Report overlays on the repertoire, the same as GET /api/report/opponent-games
// answers for the archive: the opponent's most recent games, with their mainline as plain SAN.
function opponentGames(reader, { nameKeys, color, from, to }) {
	const opponentColor = color === 'b' ? 'b' : 'w';
	const empty = { fideId: 0, opponentColor, gamesRead: 0, truncated: false, games: [] };
	if (!Array.isArray(nameKeys) || nameKeys.length === 0) {
		return empty;
	}

	const side = opponentColor === 'b' ? 'blackKey' : 'whiteKey';
	const where = [`g.${side} IN (${nameKeys.map(() => '?').join(', ')})`];
	const args = [...nameKeys];
	dateBounds(where, args, from, to);

	// One row past the cap, so truncation is a comparison rather than a second count.
	const rows = reader.db
		.prepare(
			`SELECT g.id, g.white, g.whiteElo, g.black, g.blackElo, g.result, g.year, g.event,
			        g.start, g.length, s.path AS file, s.bytes AS bytes
			 FROM game g JOIN source s ON s.id = g.sourceId
			 WHERE ${where.join(' AND ')}
			 ORDER BY g.playedOn DESC NULLS LAST, g.id DESC
			 LIMIT ?`,
		)
		.all(...args, REPORT_GAMES + 1);

	const kept = rows.slice(0, REPORT_GAMES);
	// Read in file order: on a spinning disk that is the difference between seconds and minutes.
	const order = kept.map((row, at) => at).sort((a, b) => kept[a].start - kept[b].start);
	const texts = new Array(kept.length);
	const handles = new Files();
	try {
		for (const at of order) {
			const row = kept[at];
			texts[at] = handles.read(row.file, row.bytes, row.start, row.length);
		}
	} finally {
		handles.close();
	}

	const games = kept.map((row, at) => ({
		id: row.id,
		white: row.white,
		whiteElo: row.whiteElo,
		black: row.black,
		blackElo: row.blackElo,
		result: row.result,
		year: row.year,
		event: row.event,
		movesSan: mainlineOf(texts[at]),
	}));
	return { ...empty, gamesRead: games.length, truncated: rows.length > REPORT_GAMES, games };
}

// Starts from the player's games and looks each up at the position: a player has thousands of
// games, a position can have millions.
function opponentTree(reader, { nameKeys, color, from, to, fen }) {
	if (!Array.isArray(nameKeys) || nameKeys.length === 0) {
		return summarise(fen, []);
	}
	const { db } = reader;
	const side = color === 'b' ? 'blackKey' : 'whiteKey';
	const key = keyOf(fen);
	const tables = tablesFor(reader.facts(), key);
	const where = [`g.${side} IN (${nameKeys.map(() => '?').join(', ')})`];
	const args = [key, ...nameKeys];
	dateBounds(where, args, from, to);

	const rows = db
		.prepare(
			`SELECT g.id AS gameId, g.result AS result, p.ply AS ply, p.moveId AS moveId
			 FROM game g CROSS JOIN ${tables.positions} p ON p.key = ? AND p.gameId = g.id
			 WHERE ${where.join(' AND ')}`,
		)
		.all(...args);

	// A game that came back to the position counts once, with the move it played the first time.
	const first = new Map();
	for (const row of rows) {
		const seen = first.get(row.gameId);
		if (!seen || row.ply < seen.ply) {
			first.set(row.gameId, row);
		}
	}

	const byMove = new Map();
	for (const row of first.values()) {
		let move = byMove.get(row.moveId);
		if (!move) {
			move = { moveId: row.moveId, games: 0, whiteWins: 0, draws: 0, blackWins: 0 };
			byMove.set(row.moveId, move);
		}
		move.games++;
		if (row.result === '1-0') move.whiteWins++;
		else if (row.result === '1/2-1/2') move.draws++;
		else if (row.result === '0-1') move.blackWins++;
	}

	const names = byIds(db, 'SELECT id, san, uci FROM move WHERE id IN', [...byMove.keys()]);
	const moves = [...byMove.values()]
		.filter((move) => names.has(move.moveId))
		.sort((a, b) => b.games - a.games || b.whiteWins - a.whiteWins || a.moveId - b.moveId)
		.map((move) => ({
			san: names.get(move.moveId).san,
			uci: names.get(move.moveId).uci,
			games: move.games,
			whiteWins: move.whiteWins,
			draws: move.draws,
			blackWins: move.blackWins,
			topGame: null,
		}));
	return summarise(fen, moves);
}

function search(reader, criteria) {
	const facts = reader.facts();
	const where = [];
	const args = [];

	names(facts, where, args, criteria.white, criteria.black, criteria.ignoreColours === true);
	range(where, args, 'g.whiteElo', criteria.whiteEloMin, criteria.whiteEloMax);
	range(where, args, 'g.blackElo', criteria.blackEloMin, criteria.blackEloMax);
	dateBounds(where, args, criteria.from, criteria.to);

	if (text(criteria.event)) {
		const like = fragment(criteria.event);
		if (facts.labels) {
			where.push(`g.event IN (SELECT name FROM label WHERE kind = ${LABEL_EVENT} AND ${labelMatch(facts)})`);
			args.push(like.folded);
		} else {
			where.push('lower(g.event) LIKE ?');
			args.push(like.lower);
		}
	}
	if (text(criteria.eco)) {
		// A prefix range rather than LIKE, so the eco index answers it; both letter cases, as LIKE did.
		const prefix = criteria.eco.trim();
		const cases = [...new Set([prefix.toUpperCase(), prefix.toLowerCase()])];
		where.push(`(${cases.map(() => '(g.eco >= ? AND g.eco < ?)').join(' OR ')})`);
		for (const one of cases) {
			args.push(one, after(one));
		}
	}
	if (Array.isArray(criteria.results) && criteria.results.length > 0) {
		where.push(`g.result IN (${criteria.results.map(() => '?').join(', ')})`);
		args.push(...criteria.results);
	}

	return searchPage(reader, where, args, criteria.sort, criteria.ascending, criteria.page, criteria.size);
}

function searchPage(reader, where, args, sort, ascending, page = 0, size = 50) {
	const column = SEARCH_SORTS[sort] ?? SEARCH_SORTS.DATE;
	const direction = ascending ? 'ASC' : 'DESC';
	const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
	const limit = clamp(size, 1, MAX_PAGE, 50);
	const at = clamp(page, 0, Number.MAX_SAFE_INTEGER, 0);

	const rows = reader.db
		.prepare(
			`SELECT g.id, g.white, g.whiteElo, g.black, g.blackElo, g.result, g.date, g.year,
			        g.event, g.site, g.round, g.eco, g.plyCount
			 FROM game g
			 ${filter}
			 ORDER BY ${column} ${direction} NULLS LAST, g.id ASC
			 LIMIT ? OFFSET ?`,
		)
		.all(...args, limit + 1, at * limit);

	return {
		games: rows.slice(0, limit).map((row) => ({
			...row,
			whiteFideId: null,
			whiteFideName: null,
			blackFideId: null,
			blackFideName: null,
		})),
		hasMore: rows.length > limit,
		page: at,
	};
}

function labelMatch(facts) {
	return facts.text ? 'id IN (SELECT rowid FROM label_text WHERE fold LIKE ?)' : 'fold LIKE ?';
}

// A typed fragment as a LIKE pattern: folded for the name list, where case and diacritics do not
// count; lowercased for an index without one, where LIKE ignores the case of ASCII letters only.
function fragment(typed) {
	const trimmed = typed.trim();
	return { folded: `%${fold(trimmed)}%`, lower: `%${trimmed.toLowerCase()}%` };
}

function names(facts, where, args, white, black, ignoreColours) {
	const one = text(white) ? fragment(white) : null;
	const two = text(black) ? fragment(black) : null;

	const side = (column, pattern) => {
		if (facts.labels) {
			args.push(pattern.folded);
			return `g.${column} IN (SELECT name FROM label WHERE kind = ${LABEL_PLAYER} AND ${labelMatch(facts)})`;
		}
		args.push(pattern.lower);
		return `lower(g.${column}) LIKE ?`;
	};

	if (ignoreColours && one && two) {
		const first = `(${side('white', one)} AND ${side('black', two)})`;
		const second = `(${side('white', two)} AND ${side('black', one)})`;
		where.push(`(${first} OR ${second})`);
		return;
	}
	if (ignoreColours && (one || two)) {
		const only = one ?? two;
		where.push(`(${side('white', only)} OR ${side('black', only)})`);
		return;
	}
	if (one) {
		where.push(side('white', one));
	}
	if (two) {
		where.push(side('black', two));
	}
}

function summarise(fen, moves) {
	let games = 0;
	let whiteWins = 0;
	let draws = 0;
	let blackWins = 0;
	const rows = moves.map((move) => {
		games += move.games;
		whiteWins += move.whiteWins;
		draws += move.draws;
		blackWins += move.blackWins;
		return {
			san: move.san,
			uci: move.uci,
			games: move.games,
			whiteWins: move.whiteWins,
			draws: move.draws,
			blackWins: move.blackWins,
			...shares(move.whiteWins, move.draws, move.blackWins),
			topGame: move.topGame,
		};
	});
	return { fen, games, whiteWins, draws, blackWins, ...shares(whiteWins, draws, blackWins), moves: rows };
}

function shares(whiteWins, draws, blackWins) {
	const decided = whiteWins + draws + blackWins;
	if (decided === 0) {
		return { whitePct: 0, drawPct: 0, blackPct: 0 };
	}
	return {
		whitePct: (whiteWins / decided) * 100,
		drawPct: (draws / decided) * 100,
		blackPct: (blackWins / decided) * 100,
	};
}

// Rows by id, in chunks under SQLite's variable limit.
function byIds(db, select, ids) {
	const out = new Map();
	for (let at = 0; at < ids.length; at += 500) {
		const chunk = ids.slice(at, at + 500);
		for (const row of db.prepare(`${select} (${chunk.map(() => '?').join(', ')})`).all(...chunk)) {
			out.set(row.id, row);
		}
	}
	return out;
}

// Source files opened once per call, each checked against the size it was indexed at: a file
// changed since then would give back the wrong bytes.
class Files {
	constructor() {
		this.open = new Map();
	}

	read(file, bytes, start, length) {
		let handle = this.open.get(file);
		if (handle === undefined) {
			try {
				handle = fs.openSync(file, 'r');
			} catch (error) {
				throw failure('NOT_FOUND', unreadable(file, error));
			}
			this.open.set(file, handle);
			if (Number.isFinite(bytes) && fs.fstatSync(handle).size !== bytes) {
				throw failure(
					'FAILED',
					`${file} has changed since it was indexed. Resume the database in Local resources to read it again.`,
				);
			}
		}
		const buffer = Buffer.alloc(length);
		fs.readSync(handle, buffer, 0, length, start);
		return buffer.toString('utf8');
	}

	close() {
		for (const handle of this.open.values()) {
			fs.closeSync(handle);
		}
		this.open.clear();
	}
}

// The index holds positions and headers; the moves of a game are read from the PGN it was built from.
function unreadable(file, error) {
	if (error.code === 'ENOENT') {
		return (
			`${file} is no longer there. Games are opened, and reports built, from the PGN the database was ` +
			`indexed from: put the file back in that folder. The opening tree and the game lists work without it.`
		);
	}
	return `${file} cannot be read (${error.code ?? error.message}).`;
}

// The mainline as space-separated SAN; null for a game set up from another position, which the
// report (it walks from move one) cannot place.
function mainlineOf(text) {
	if (text === null) {
		return null;
	}
	const movetext = [];
	for (const line of text.split(/\r?\n/)) {
		const tag = /^\s*\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/.exec(line);
		if (tag) {
			if (tag[1] === 'FEN' && tag[2].trim() !== STANDARD_START) {
				return null;
			}
			continue;
		}
		movetext.push(line);
	}
	const moves = sanTokens(movetext.join('\n')).slice(0, REPORT_PLIES);
	return moves.length > 0 ? moves.join(' ') : null;
}

function dateBounds(where, args, from, to) {
	bound(where, args, from, '>=');
	bound(where, args, to, '<=');
}

// A game dated "2026.??.??" has a year but no day, so the bound applies to whichever column it has.
function bound(where, args, iso, op) {
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? '').trim());
	if (!day) {
		return;
	}
	where.push(`(g.playedOn ${op} ? OR (g.playedOn IS NULL AND g.year ${op} ?))`);
	args.push(day[0], Number(day[1]));
}

function range(where, args, column, min, max) {
	if (Number.isFinite(min)) {
		where.push(`${column} >= ?`);
		args.push(min);
	}
	if (Number.isFinite(max)) {
		where.push(`${column} <= ?`);
		args.push(max);
	}
}

// The smallest string greater than every string that starts with prefix.
function after(prefix) {
	return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

function text(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

function clamp(value, low, high, fallback) {
	const number = Math.floor(Number(value));
	return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
}

function failure(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

const METHODS = { tree, games, game, players, opponent, opponentGames, opponentTree, search };

module.exports = { Reader, METHODS };
