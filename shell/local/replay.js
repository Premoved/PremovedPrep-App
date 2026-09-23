'use strict';

const crypto = require('node:crypto');
const { Chess } = require('chess.js');

const SQUARES = [];
for (let at = 0; at < 128; at++) {
	SQUARES[at] = 'abcdefgh'[at & 0xf] + '87654321'[at >> 4];
}

const NULL_MOVE = 128;

/** Excludes move counters, so any order to the same position shares a key; changing it invalidates every index. */
function keyOf(fen) {
	const fields = fen.trim().split(/\s+/).slice(0, 4).join(' ');
	return crypto.createHash('sha1').update(fields).digest().subarray(0, 12);
}

function boardKey(fen) {
	let at = -1;
	for (let field = 0; field < 4; field++) {
		at = fen.indexOf(' ', at + 1);
	}
	return crypto
		.createHash('sha1')
		.update(at === -1 ? fen : fen.slice(0, at))
		.digest()
		.subarray(0, 12);
}

// Reaches into chess.js internals pinned to this version; `fast` below verifies equivalence with move() at load time.
function playFast(board, san) {
	const move = board._moveFromSan(san, false);
	if (!move) {
		return null;
	}
	if (move.flags & NULL_MOVE) {
		return playSlow(board, san);
	}
	const written = board._moveToSan(move, board._moves({ legal: true, piece: move.piece }));
	board._makeMove(move);
	return { san: written, uci: SQUARES[move.from] + SQUARES[move.to] + (move.promotion ?? '') };
}

function playSlow(board, san) {
	const move = board.move(san);
	if (!move) {
		return null;
	}
	return { san: move.san, uci: `${move.from}${move.to}${move.promotion ?? ''}` };
}

function replay(plies, setup, maxPly, visit, play = fast ? playFast : playSlow) {
	const board = new Chess();
	if (setup) {
		try {
			board.load(setup);
		} catch {
			return 0;
		}
	}

	let ply = 0;
	for (const san of plies) {
		if (maxPly > 0 && ply >= maxPly) break;
		const key = boardKey(board.fen());
		let move;
		try {
			move = play(board, san);
		} catch {
			break;
		}
		if (!move) break;
		visit(key, move.san, move.uci);
		ply++;
	}
	return ply;
}

// Falls back to the slower, always-correct path if the fast path's output ever differs.
const fast = (() => {
	const proto = Chess.prototype;
	if (!['_moveFromSan', '_moveToSan', '_moves', '_makeMove'].every((name) => typeof proto[name] === 'function')) {
		return false;
	}
	const games = [
		[null, 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 Nbd2 Bb7 Bc2 Re8 Nf1 Bf8 Ng3'],
		[null, 'e4 d5 e5 f5 exf6 Nc6 fxg7 Bf5 gxh8=Q Qd7 Qxg8+ O-O-O Qxf8 Rxf8 d4 e5 dxe5 Nxe5'],
		[null, 'f3 e5 g4 Qh4#'],
		['4k3/1P6/8/8/8/8/p7/4K2R w K - 0 1', 'b8=Q+ Kd7 O-O a1=N Qb5+ Kd6 Rf6+ Ke7'],
		['r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1', 'exd6 O-O-O Ra2 Rxd6 O-O Rh7'],
	];
	try {
		for (const [setup, text] of games) {
			const seen = { fast: [], slow: [] };
			const plies = text.split(' ');
			const fastPlies = replay(
				plies,
				setup,
				0,
				(key, san, uci) => seen.fast.push(key.toString('hex'), san, uci),
				playFast,
			);
			const slowPlies = replay(
				plies,
				setup,
				0,
				(key, san, uci) => seen.slow.push(key.toString('hex'), san, uci),
				playSlow,
			);
			if (fastPlies !== plies.length || slowPlies !== plies.length || seen.fast.join() !== seen.slow.join()) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
})();

module.exports = { keyOf, replay, playFast, playSlow, fast };
