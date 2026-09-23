// Compares the indexer's fast chess.js replay path against move(), position by position.
// The fast path reaches into chess.js internals; a chess.js upgrade can break it without erroring.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const { replay, playFast, playSlow, fast } = require('../shell/local/replay.js');

const count = Number(process.argv[2] ?? 500);

// Deterministic, so a failing game can be reproduced.
let seed = 20260921;
function random(below) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % below;
}

function randomGame() {
	const board = new Chess();
	const plies = [];
	const length = 20 + random(200);
	while (plies.length < length && !board.isGameOver()) {
		const moves = board.moves();
		const san = moves[random(moves.length)];
		board.move(san);
		plies.push(san);
	}
	return plies;
}

function collect(plies, play) {
	const seen = [];
	const played = replay(plies, null, 0, (key, san, uci) => seen.push(`${key.toString('hex')} ${san} ${uci}`), play);
	return { played, seen };
}

let failures = 0;
let positions = 0;

if (!fast) {
	console.error('The fast replay is switched off: chess.js no longer matches it. Indexing would run at half speed.');
	failures++;
}

for (let at = 0; at < count; at++) {
	const plies = randomGame();
	const quick = collect(plies, playFast);
	const sure = collect(plies, playSlow);
	positions += sure.played;

	if (quick.played !== sure.played || quick.seen.join('\n') !== sure.seen.join('\n')) {
		failures++;
		if (failures <= 5) {
			console.error(`Game ${at} differs: ${plies.join(' ')}`);
		}
	}
}

if (failures > 0) {
	console.error(`check-replay: ${failures} failure(s).`);
	process.exit(1);
}
console.log(`check-replay: ${count} games, ${positions} positions, fast and move() agree.`);
