// Export and Import, end to end: a small database is indexed, exported to one .ppdb file, imported
// into a second, empty install, and must answer every query as the original does. Games added to the
// imported copy must not cost it any of the imported ones; a file that is not a whole, current export
// must leave no trace; an import the application closed in the middle of must disappear at start-up.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const { DatabaseSync } = require('node:sqlite');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'premoved-transfer-'));
// On Windows the indexes go to %LOCALAPPDATA%\PremovedPrep\Databases, read when a Databases is made:
// pointed into the temporary folder, so the check never touches the real one.
process.env.LOCALAPPDATA = path.join(root, 'local');
const { Databases } = require('../shell/local/database.js');

// Every step is named as it starts; one that takes too long names itself and fails the check.
const STEP_MS = 180_000;
let step = 'starting';
let stepTimer = null;
function at(name) {
	step = name;
	console.log(`- ${name}`);
	clearTimeout(stepTimer);
	stepTimer = setTimeout(() => {
		console.error(`STUCK for ${STEP_MS / 1000} s at: ${step}`);
		process.exit(1);
	}, STEP_MS);
	stepTimer.unref();
}

let seed = 20261114;
function random(below) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % below;
}

const NAMES = Array.from({ length: 40 }, (_, at) => `Player${at.toString(36)}, ${'ABCDE'[at % 5]}`);

function pgn(games, event) {
	const out = [];
	for (let game = 0; game < games; game++) {
		const board = new Chess();
		const plies = [];
		for (let ply = 0; ply < 24; ply++) {
			const moves = board.moves();
			if (moves.length === 0) break;
			const san = moves[ply < 6 ? random(Math.min(3, moves.length)) : random(moves.length)];
			board.move(san);
			plies.push(san);
		}
		const result = ['1-0', '0-1', '1/2-1/2'][random(3)];
		const tags = [
			`[Event "${event}"]`,
			`[Date "20${10 + random(15)}.0${1 + random(9)}.1${random(9)}"]`,
			`[White "${NAMES[random(NAMES.length)]}"]`,
			`[Black "${NAMES[random(NAMES.length)]}"]`,
			`[Result "${result}"]`,
			`[WhiteFideId "${1000 + random(40)}"]`,
		];
		const text = plies.map((san, at) => (at % 2 === 0 ? `${at / 2 + 1}. ${san}` : san)).join(' ');
		out.push(`${tags.join('\n')}\n\n${text} ${result}\n`);
	}
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
function ok(name, condition) {
	same(name, true, Boolean(condition));
}
async function refuses(name, promise, pattern, code) {
	checks++;
	try {
		await promise;
		failures++;
		console.error(`DIFF ${name}: did not refuse`);
	} catch (error) {
		if (!pattern.test(error.message) || (code && error.code !== code)) {
			failures++;
			console.error(`DIFF ${name}: ${error.code ?? ''} ${error.message}`);
		}
	}
}

class Settings {
	constructor(value) {
		this.value = { databases: [], nextDatabaseId: 1, ...value };
	}
	update(patch) {
		this.value = { ...this.value, ...patch };
		return this.value;
	}
	takeDatabaseId() {
		const id = this.value.nextDatabaseId;
		this.update({ nextDatabaseId: id + 1 });
		return id;
	}
}

const files = path.join(root, 'files');
fs.mkdirSync(files);
const first = path.join(files, 'first.pgn');
const second = path.join(files, 'second.pgn');
fs.writeFileSync(first, pgn(400, 'Open Berlin 2024'));
fs.writeFileSync(second, pgn(120, 'Paris Rapid 2025'));

const quiet = () => undefined;
// Where a Databases made with this folder keeps its indexes, on every system.
const indexesOf = (directory) =>
	process.platform === 'win32'
		? path.join(process.env.LOCALAPPDATA, 'PremovedPrep', 'Databases')
		: path.join(directory, 'local-databases');
const start = new Chess().fen();
const afterE4 = (() => {
	const board = new Chess();
	board.move('e4');
	return board.fen();
})();

async function answers(databases, id) {
	const out = {};
	for (const fen of [start, afterE4]) {
		out[`tree ${fen}`] = await databases.tree(id, fen, null);
		out[`games ${fen}`] = await databases.games(id, fen, 'DATE', false, 0, 50, null);
	}
	out.players = await databases.players(id, 'player1', 20, null);
	out.game = await databases.game(id, 7, null);
	out.search = await databases.search(id, { white: 'Player2' }, null);
	return out;
}

let exporter;
let importer;
try {
	// The exporting computer.
	at('index a PGN');
	exporter = new Databases(new Settings(), path.join(root, 'one'), quiet);
	const own = await exporter.add(first, 'TWIC test');
	await exporter.prepareAll();
	at('answers of the original');
	const original = await answers(exporter, own.id);

	const target = path.join(root, 'out', 'TWIC test.ppdb');
	fs.mkdirSync(path.dirname(target));
	at('export');
	await exporter.exportTo(own.id, target);
	ok(
		'export is one file',
		fs.existsSync(target) && !fs.existsSync(`${target}-wal`) && !fs.existsSync(`${target}.part`),
	);
	{
		const db = new DatabaseSync(target, { readOnly: true });
		same('export journal', 'delete', db.prepare('PRAGMA journal_mode').get().journal_mode);
		same(
			'export keeps only file names',
			['first.pgn'],
			db
				.prepare('SELECT path FROM source')
				.all()
				.map((row) => row.path),
		);
		db.close();
	}
	at('answers after the export');
	same('exported database still answers the same', original, await answers(exporter, own.id));

	// The importing computer: nothing of the PGNs, another folder.
	at('import');
	importer = new Databases(new Settings(), path.join(root, 'two'), quiet);
	const imported = await importer.importFrom(target);
	same(
		'imported card',
		{ name: 'TWIC test', games: own.games, positions: own.positions, ready: true },
		{ name: imported.name, games: imported.games, positions: imported.positions, ready: imported.ready },
	);
	at('answers of the import');
	same('imported answers', original, await answers(importer, imported.id));
	ok(
		'imported index has no leftovers',
		fs.readdirSync(path.dirname(imported.location)).every((name) => !name.endsWith('.part')),
	);

	at('rebuild refused');
	await refuses('rebuild without the PGNs', importer.rebuild(imported.id), /is not on this computer/);
	same('still ready after the refused rebuild', true, importer.list().find((one) => one.id === imported.id).ready);

	// Games added to the imported copy join the imported ones.
	at('add games to the import');
	const added = await importer.append(imported.id, second);
	same('added games', own.games + 120, added.games);
	const tree = await importer.tree(imported.id, start, null);
	same('tree counts every game', own.games + 120, tree.games);

	// Exported again from the importing computer, imported back: still the same.
	at('export again, import back');
	const again = path.join(root, 'out', 'again.ppdb');
	await importer.exportTo(imported.id, again);
	const back = await exporter.importFrom(again);
	same('re-imported games', own.games + 120, back.games);

	// Files that must be refused, leaving the list and the folder as they were.
	at('files that must be refused');
	const before = importer.list().length;
	const folder = () => fs.readdirSync(indexesOf(path.join(root, 'two'))).sort();
	const kept = folder();
	await refuses('a PGN', importer.importFrom(first), /not a database exported from PremovedPrep/);
	const truncated = path.join(root, 'out', 'cut.ppdb');
	fs.writeFileSync(truncated, fs.readFileSync(target).subarray(0, Math.floor(fs.statSync(target).size / 2)));
	await refuses('half a file', importer.importFrom(truncated), /not a whole export|not a database exported/);
	const newer = path.join(root, 'out', 'newer.ppdb');
	fs.copyFileSync(target, newer);
	{
		const db = new DatabaseSync(newer);
		db.exec(`UPDATE meta SET value = 99 WHERE key = 'indexVersion'`);
		db.close();
	}
	await refuses('a newer export', importer.importFrom(newer), /newer version/, 'NEWER_VERSION');
	const plain = path.join(root, 'out', 'plain.ppdb');
	fs.copyFileSync(own.location, plain);
	await refuses('an index that was not exported', importer.importFrom(plain), /not a database exported/);
	same('refused files leave the list alone', before, importer.list().length);
	same('refused files leave the folder alone', kept, folder());

	at('unfinished import at start-up');
	// An import cut short by closing the application.
	const half = path.join(root, 'three', 'half.sqlite');
	fs.mkdirSync(path.dirname(half), { recursive: true });
	fs.writeFileSync(`${half}.part`, 'x');
	const leftover = new Settings({
		databases: [{ id: 9, name: 'half', index: half, importing: true, sources: [] }],
		nextDatabaseId: 10,
	});
	const restarted = new Databases(leftover, path.join(root, 'three'), quiet);
	same('unfinished import gone from the list', [], restarted.list());
	ok('unfinished import gone from the folder', !fs.existsSync(`${half}.part`));
	restarted.closeAll();
} catch (error) {
	failures++;
	console.error(`FAILED at: ${step}\n${error?.stack ?? error}`);
} finally {
	exporter?.closeAll();
	importer?.closeAll();
}
clearTimeout(stepTimer);

try {
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
	// A worker still closing its file on Windows: the temporary folder is left for the system to clear.
}
console.log(`${checks - failures}/${checks} export and import checks passed`);
process.exit(failures === 0 ? 0 : 1);
