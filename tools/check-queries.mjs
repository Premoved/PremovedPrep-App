// Builds a small index and checks every local query against a brute-force answer from the same
// tables, on both paths of the games list (index probe and direct) and after preparing an index
// that lacked the sort indexes and the name list.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const { DatabaseSync } = require('node:sqlite');
const { build, isPrepared } = require('../shell/local/index-worker.js');
const { Reader, METHODS } = require('../shell/local/queries.js');
const { keyOf, positionsOf, GAME_INDEXES } = require('../shell/local/layout.js');

const GAMES = Number(process.argv[2] ?? 1500);

let seed = 20261113;
function random(below) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % below;
}

const FIRST = ['e4', 'e4', 'e4', 'd4', 'd4', 'c4', 'Nf3'];
const NAMES = Array.from({ length: 120 }, (_, at) => `Player${at.toString(36)}, ${'ABCDE'[at % 5]}`);
const EVENTS = ['Open Berlin', 'Paris Rapid', 'Tata Steel', 'Olympiad'];

function pgn() {
	const out = [];
	for (let game = 0; game < GAMES; game++) {
		const board = new Chess();
		const plies = [];
		for (let ply = 0; ply < 30; ply++) {
			const moves = board.moves();
			if (moves.length === 0) break;
			// Few choices early, so some positions are shared by most games and others by one.
			const san =
				ply === 0
					? FIRST[random(FIRST.length)]
					: moves[ply < 6 ? random(Math.min(3, moves.length)) : random(moves.length)];
			board.move(san);
			plies.push(san);
		}
		const year = 1990 + random(36);
		const tags = {
			Event: `${EVENTS[random(EVENTS.length)]} ${year}`,
			Date: random(10) === 0 ? `${year}.??.??` : `${year}.0${1 + random(9)}.1${random(9)}`,
			White: NAMES[Math.floor(Math.pow(random(1000) / 1000, 2) * NAMES.length)],
			Black: NAMES[random(NAMES.length)],
			Result: ['1-0', '0-1', '1/2-1/2'][random(3)],
			ECO: ['B90', 'C42', 'b12', 'A04'][random(4)],
		};
		if (random(6) > 0) tags.WhiteElo = String(1800 + random(1000));
		if (random(6) > 0) tags.BlackElo = String(1800 + random(1000));
		const text = plies.map((san, at) => (at % 2 === 0 ? `${at / 2 + 1}. ${san}` : san)).join(' ');
		out.push(
			`${Object.entries(tags)
				.map(([k, v]) => `[${k} "${v}"]`)
				.join('\n')}\n\n${text} ${tags.Result}\n`,
		);
	}
	// Names and an event with diacritics, for the accent-insensitive search.
	out.push(
		'[Event "Çeşme Open 2020"]\n[Date "2020.05.05"]\n[White "Öztürk, Ali"]\n[Black "Müller, Karsten"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n',
	);
	return out.join('\n');
}

let failures = 0;
let checks = 0;
function same(name, want, got) {
	checks++;
	if (JSON.stringify(want) !== JSON.stringify(got)) {
		failures++;
		console.error(
			`DIFF ${name}\n  want ${JSON.stringify(want).slice(0, 300)}\n  got  ${JSON.stringify(got).slice(0, 300)}`,
		);
	}
}

function fenAfter(line) {
	const board = new Chess();
	for (const san of line) board.move(san);
	return board.fen();
}

function check(reader, raw, label) {
	const firstGame = raw.prepare('SELECT start, length FROM game WHERE id = 1').get();
	const text = fs
		.readFileSync(file)
		.subarray(firstGame.start, firstGame.start + firstGame.length)
		.toString();
	const played = new Chess();
	played.loadPgn(text);
	const line = played.history();
	const fens = [[], ['e4'], ['d4'], line.slice(0, 3), line.slice(0, 8)].map(fenAfter);

	const COLUMNS = {
		STRENGTH: 'strength',
		WHITE_NAME: 'white',
		WHITE_ELO: 'whiteElo',
		RESULT: 'result',
		BLACK_NAME: 'black',
		BLACK_ELO: 'blackElo',
		DATE: 'date',
		EVENT: 'event',
	};
	for (const fen of fens) {
		const key = keyOf(fen);
		const all = raw
			.prepare(
				`SELECT g.id, g.white, g.whiteElo, g.black, g.blackElo, g.result, g.date, g.year, g.event, g.eco,
				        MIN(p.ply) AS ply, g.strength
				 FROM ${positionsOf(key[0])} p JOIN game g ON g.id = p.gameId WHERE p.key = ? GROUP BY g.id`,
			)
			.all(key);
		for (const [sort, column] of Object.entries(COLUMNS)) {
			for (const ascending of [false, true]) {
				const sorted = [...all].sort((x, y) => {
					const a = x[column];
					const b = y[column];
					if (a === null || b === null) return a === b ? (x.id - y.id) * (ascending ? 1 : -1) : a === null ? 1 : -1;
					if (a !== b) return (a < b ? -1 : 1) * (ascending ? 1 : -1);
					return (x.id - y.id) * (ascending ? 1 : -1);
				});
				for (const page of [0, 2]) {
					const got = METHODS.games(reader, { fen, sort, ascending, page, size: 25 });
					const want = sorted.slice(page * 25, page * 25 + 25).map(({ strength, ...row }) => row);
					same(
						`${label} games ${sort} ${ascending} page ${page} (${all.length})`,
						{ want, more: sorted.length > page * 25 + 25 },
						{ want: got.games, more: got.hasMore },
					);
				}
			}
		}

		const nameKeys = raw
			.prepare('SELECT whiteKey FROM game GROUP BY whiteKey ORDER BY COUNT(*) DESC LIMIT 2')
			.all()
			.map((row) => row.whiteKey);
		for (const color of ['w', 'b']) {
			const side = color === 'b' ? 'blackKey' : 'whiteKey';
			const rows = raw
				.prepare(
					`SELECT m.san, COUNT(*) AS games FROM (
					   SELECT p.gameId, p.moveId FROM ${positionsOf(key[0])} p JOIN game g ON g.id = p.gameId
					   WHERE p.key = ? AND g.${side} IN (?, ?) AND p.ply = (SELECT MIN(ply) FROM ${positionsOf(key[0])} q WHERE q.key = p.key AND q.gameId = p.gameId)
					 ) x JOIN move m ON m.id = x.moveId GROUP BY m.san ORDER BY m.san`,
				)
				.all(key, ...nameKeys);
			const got = METHODS.opponentTree(reader, { nameKeys, color, fen }).moves.map((move) => ({
				san: move.san,
				games: move.games,
			}));
			same(
				`${label} opponentTree ${color}`,
				rows.map((row) => ({ ...row })),
				got.sort((a, b) => (a.san < b.san ? -1 : 1)),
			);
		}
	}

	const like = (column, pattern) => `lower(${column}) LIKE '%${pattern.toLowerCase()}%'`;
	const cases = [
		[{ white: 'player1' }, like('white', 'player1')],
		[{ white: 'yer2', black: 'B' }, `${like('white', 'yer2')} AND ${like('black', 'B')}`],
		[{ white: 'player3', ignoreColours: true }, `(${like('white', 'player3')} OR ${like('black', 'player3')})`],
		[{ event: 'berl' }, like('event', 'berl')],
		[{ eco: 'b1' }, `upper(eco) LIKE 'B1%'`],
		[{ whiteEloMin: 2600 }, 'whiteElo >= 2600'],
		[{ white: 'zz' }, like('white', 'zz')],
	];
	for (const [criteria, where] of cases) {
		const want = raw
			.prepare(`SELECT id FROM game WHERE ${where} ORDER BY playedOn DESC NULLS LAST, id ASC LIMIT 40`)
			.all()
			.map((row) => row.id);
		const got = METHODS.search(reader, { ...criteria, sort: 'DATE', page: 0, size: 40 }).games.map((row) => row.id);
		same(`${label} search ${JSON.stringify(criteria)}`, want, got);
	}
	for (const q of ['player1', 'AYER', 'p', '']) {
		const want = raw
			.prepare(
				`SELECT name, MAX(elo) AS topElo FROM (SELECT white AS name, whiteElo AS elo FROM game UNION ALL SELECT black, blackElo FROM game)
				 WHERE lower(name) LIKE ? GROUP BY name ORDER BY topElo DESC NULLS LAST, name ASC LIMIT 12`,
			)
			.all(`%${q.toLowerCase()}%`);
		same(
			`${label} players "${q}"`,
			want.map((row) => ({ ...row })),
			METHODS.players(reader, { q, limit: 12 }).map((row) => ({ ...row })),
		);
	}

	// Without the name list (an index not prepared yet) the match is on the text as written.
	if (label !== 'unprepared') {
		for (const q of ['ozturk', 'ÖZTÜRK', 'Öztürk, a']) {
			same(
				`${label} players "${q}"`,
				['Öztürk, Ali'],
				METHODS.players(reader, { q }).map((row) => row.name),
			);
		}
		const found = (criteria) =>
			METHODS.search(reader, { ...criteria, sort: 'DATE', page: 0, size: 5 }).games.map((row) => row.black);
		same(`${label} search without diacritics`, ['Müller, Karsten'], found({ black: 'muller' }));
		same(`${label} search either colour`, ['Müller, Karsten'], found({ white: 'MULLER', ignoreColours: true }));
		same(`${label} event without diacritics`, ['Müller, Karsten'], found({ event: 'cesme' }));
	}
}

// The game texts kept in the index: the same as the PGN, read without it, and copied into an
// index made before they were kept, from a PGN with Windows line ends.
async function checkTexts(directory) {
	const crlf = path.join(directory, 'crlf.pgn');
	fs.writeFileSync(crlf, pgn().split('\n').slice(0, 4000).join('\r\n'));
	const source = { path: crlf, bytes: fs.statSync(crlf).size };
	const index = path.join(directory, 'texts.sqlite');
	await build({ sources: [source], index, maxPly: 30, restart: true });

	const raw = new DatabaseSync(index, { readOnly: true });
	const rows = raw.prepare('SELECT id, start, length FROM game ORDER BY id').all();
	raw.close();
	const bytes = fs.readFileSync(crlf);
	const expected = new Map(
		rows.map((row) => [
			row.id,
			bytes
				.subarray(row.start, row.start + row.length)
				.toString('utf8')
				.replace(/\r\n/g, '\n')
				.trim(),
		]),
	);
	const texts = (reader) => rows.map((row) => METHODS.game(reader, { gameId: row.id }).pgn);
	let reader = new Reader(index);
	same('texts as in the PGN', [...expected.values()], texts(reader));
	reader.close();

	// The PGN deleted: games still open and the report still has their moves.
	fs.renameSync(crlf, `${crlf}.away`);
	reader = new Reader(index);
	same('texts without the PGN', [...expected.values()], texts(reader));
	// Closed at once: Windows cannot delete the folder at the end while a handle is open.
	const counted = new DatabaseSync(index, { readOnly: true });
	const keys = counted
		.prepare('SELECT whiteKey FROM game GROUP BY whiteKey ORDER BY COUNT(*) DESC LIMIT 1')
		.all()
		.map((row) => row.whiteKey);
	counted.close();
	const report = METHODS.opponentGames(reader, { nameKeys: keys, color: 'w' });
	same('report without the PGN', true, report.games.length > 0 && report.games.every((one) => one.movesSan));
	reader.close();
	fs.renameSync(`${crlf}.away`, crlf);

	// An index from before the texts were kept: read from the PGN, then copied into it.
	const legacy = new DatabaseSync(index);
	legacy.exec(`DROP TABLE gametext; DELETE FROM meta WHERE key = 'gameTexts'`);
	same('legacy isPrepared', false, isPrepared(legacy));
	legacy.close();
	reader = new Reader(index);
	same('legacy texts from the PGN', [...expected.values()], texts(reader));
	reader.close();
	await build({ index, prepareOnly: true, sources: [], maxPly: 30 });
	fs.renameSync(crlf, `${crlf}.away`);
	reader = new Reader(index);
	same('legacy texts copied', [...expected.values()], texts(reader));
	reader.close();

	// The same, with the PGN already gone: preparing finishes and opening a game says why it cannot.
	const gone = new DatabaseSync(index);
	gone.exec(`DROP TABLE gametext; DELETE FROM meta WHERE key = 'gameTexts'`);
	gone.close();
	await build({ index, prepareOnly: true, sources: [], maxPly: 30 });
	const after = new DatabaseSync(index, { readOnly: true });
	same('prepared without the PGN', true, isPrepared(after));
	after.close();
	reader = new Reader(index);
	let message = '';
	try {
		METHODS.game(reader, { gameId: rows[0].id });
	} catch (error) {
		message = `${error.code} ${error.message}`;
	}
	same('missing PGN explained', true, message.startsWith('NOT_FOUND') && message.includes('no longer there'));
	reader.close();
}

// Players found as the server finds them: by the FIDE id a game carries, by name only where it carries
// none. TWIC writes "Caruana,F", whose name key never meets the profile's "caruana|fabiano".
const FIDE_GAMES = [
	['F1', 'Caruana,F', 'Ponkratov,P', '2020009', '4157800'],
	['F2', 'Nepomniachtchi,I', 'Caruana,F', '4168119', '2020009'],
	// No tag: "caruana" is learned from his tagged games.
	['F3', 'Caruana,F', 'Someone,X', null, null],
	// No tag, the profile's own spelling.
	['F4', 'Caruana, Fabiano', 'Other, Guy', null, null],
	// Tagged with another id: not his, whatever the name says.
	['F5', 'Caruana, Fabiano', 'Other, Guy', '9999', null],
	['F6', 'Carlsen,M', 'Someone,X', '1503014', null],
	['F7', 'Carlsen,H', 'Someone,X', '1500000', null],
	// "carlsen" belongs to two ids: neither learns it.
	['F8', 'Carlsen,M', 'Someone,X', null, null],
	// A name too short for a key, found by its spelling.
	['F9', 'Li, Bo', 'Someone,X', null, null],
	// 0 is no id, as on the server.
	['F10', 'Caruana,F', 'Someone,X', '0', null],
];

function fidePgn() {
	return FIDE_GAMES.map(([event, white, black, whiteId, blackId], at) => {
		const tags = [`[Event "${event}"]`, `[Date "2024.01.${10 + at}"]`, `[White "${white}"]`, `[Black "${black}"]`];
		tags.push('[Result "1-0"]');
		if (whiteId !== null) tags.push(`[WhiteFideId "${whiteId}"]`);
		if (blackId !== null) tags.push(`[BlackFideId "${blackId}"]`);
		return `${tags.join('\n')}\n\n1. e4 e5 2. Nf3 Nc6 1-0\n`;
	}).join('\n');
}

const CARUANA = { fideId: 2020009, nameKeys: ['caruana|fabiano'], spellings: ['caruana, fabiano'] };
const CARLSEN = { fideId: 1503014, nameKeys: ['carlsen|magnus'], spellings: ['carlsen, magnus'] };
const LI_BO = { fideId: 8600001, nameKeys: [], spellings: ['li, bo'] };
// The server unreachable: no names, the id alone.
const CARUANA_OFFLINE = { fideId: 2020009, nameKeys: [], spellings: [] };

function checkPlayers(reader, label, expected) {
	const START = new Chess().fen();
	for (const [name, scope, color, events] of expected) {
		const listed = METHODS.opponent(reader, { ...scope, color, sort: 'DATE', page: 0, size: 50 }).games;
		same(`${label} ${name} ${color} games list`, events, listed.map((row) => row.event).sort());
		const report = METHODS.opponentGames(reader, { ...scope, color });
		same(`${label} ${name} ${color} report`, events, report.games.map((row) => row.event).sort());
		const tree = METHODS.opponentTree(reader, { ...scope, color, fen: START });
		same(`${label} ${name} ${color} opening tree`, events.length, tree.games);
	}
}

async function checkFideIds(directory) {
	const file = path.join(directory, 'fide.pgn');
	fs.writeFileSync(file, fidePgn());
	const index = path.join(directory, 'fide.sqlite');
	await build({ sources: [{ path: file, bytes: fs.statSync(file).size }], index, maxPly: 30, restart: true });

	const byId = [
		['Caruana', CARUANA, 'w', ['F1', 'F10', 'F3', 'F4']],
		['Caruana', CARUANA, 'b', ['F2']],
		['Caruana offline', CARUANA_OFFLINE, 'w', ['F1', 'F10', 'F3']],
		['Carlsen', CARLSEN, 'w', ['F6']],
		['Li Bo', LI_BO, 'w', ['F9']],
	];
	let reader = new Reader(index);
	checkPlayers(reader, 'built', byId);
	const ids = METHODS.search(reader, { event: 'F1', sort: 'DATE', page: 0, size: 5 }).games.find(
		(row) => row.event === 'F1',
	);
	same('search keeps the ids', [2020009, 4157800], [ids.whiteFideId, ids.blackFideId]);
	reader.close();

	// An index from before the ids were kept: found by name until prepared, then by id from the stored texts.
	const old = new DatabaseSync(index);
	old.exec('DROP INDEX game_white_fide; DROP INDEX game_black_fide');
	old.exec('ALTER TABLE game DROP COLUMN whiteFideId; ALTER TABLE game DROP COLUMN blackFideId');
	old.exec(`DELETE FROM meta WHERE key = 'fideIds'`);
	same('no ids isPrepared', false, isPrepared(old));
	old.close();
	reader = new Reader(index);
	checkPlayers(reader, 'no ids', [
		['Caruana', CARUANA, 'w', ['F4', 'F5']],
		['Caruana offline', CARUANA_OFFLINE, 'w', []],
	]);
	reader.close();
	// Moved away: the ids come out of the texts kept in the index, not out of the PGN.
	fs.renameSync(file, `${file}.away`);
	await build({ index, prepareOnly: true, sources: [], maxPly: 30 });
	const prepared = new DatabaseSync(index, { readOnly: true });
	same('ids read isPrepared', true, isPrepared(prepared));
	prepared.close();
	reader = new Reader(index);
	checkPlayers(reader, 'ids read', byId);
	reader.close();
	fs.renameSync(`${file}.away`, file);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'check-queries-'));
const file = path.join(directory, 'games.pgn');
try {
	fs.writeFileSync(file, pgn());
	const index = path.join(directory, 'index.sqlite');
	await build({ sources: [{ path: file, bytes: fs.statSync(file).size }], index, maxPly: 30, restart: true });

	for (const label of ['built', 'prepared']) {
		const raw = new DatabaseSync(index, { readOnly: true });
		same(`${label} isPrepared`, true, isPrepared(raw));
		const reader = new Reader(index);
		check(reader, raw, label);
		reader.close();
		raw.close();
		if (label === 'built') {
			// An index from before this version: no sort indexes and no name list, then prepared.
			const writer = new DatabaseSync(index);
			for (const [name] of GAME_INDEXES.slice(3)) writer.exec(`DROP INDEX ${name}`);
			writer.exec('DROP TABLE IF EXISTS label_text; DROP TABLE label; DROP TABLE meta');
			same('old isPrepared', false, isPrepared(writer));
			const before = new Reader(index);
			check(before, writer, 'unprepared');
			before.close();
			writer.close();
			await build({ index, prepareOnly: true, sources: [], maxPly: 30 });
		}
	}

	await checkTexts(directory);
	await checkFideIds(directory);
} finally {
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`check-queries: ${checks - failures}/${checks} ${failures === 0 ? 'OK' : 'FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
