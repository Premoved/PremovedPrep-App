'use strict';

function countTree(db, table, result, rank) {
	// Only positions reached by more than one game cross into JS; SQLite filters the rest while reading.
	const rows = db.prepare(
		`SELECT key, gameId, moveId FROM ${table}
		 WHERE key IN (SELECT key FROM ${table} GROUP BY key HAVING COUNT(*) > 1)`,
	);
	const asArrays = typeof rows.setReturnArrays === 'function';
	if (asArrays) {
		rows.setReturnArrays(true);
	}

	const out = new TreeRows();
	let current = null;
	const groupGames = [];
	const groupMoves = [];

	const flush = () => {
		if (groupGames.length < 2) {
			return;
		}
		// [games, white wins, draws, black wins, best rank, best game] per move.
		const byMove = new Map();
		for (let at = 0; at < groupGames.length; at++) {
			const gameId = groupGames[at];
			let entry = byMove.get(groupMoves[at]);
			if (!entry) {
				entry = [0, 0, 0, 0, -1, 0];
				byMove.set(groupMoves[at], entry);
			}
			entry[0]++;
			const outcome = result[gameId];
			if (outcome === 1) entry[1]++;
			else if (outcome === 2) entry[2]++;
			else if (outcome === 3) entry[3]++;
			// Rows come in game order, so the first of equal rank is the lowest id.
			if (rank[gameId] > entry[4]) {
				entry[4] = rank[gameId];
				entry[5] = gameId;
			}
		}
		const moves = [...byMove.keys()].sort((a, b) => a - b);
		for (const move of moves) {
			const entry = byMove.get(move);
			out.push(current, move, entry[0], entry[1], entry[2], entry[3], entry[5]);
		}
	};

	for (const row of rows.iterate()) {
		const key = asArrays ? row[0] : row.key;
		if (current === null || !sameKey(current, key)) {
			flush();
			current = key;
			groupGames.length = 0;
			groupMoves.length = 0;
		}
		groupGames.push(asArrays ? row[1] : row.gameId);
		groupMoves.push(asArrays ? row[2] : row.moveId);
	}
	flush();

	return out.finish();
}

class TreeRows {
	constructor() {
		this.size = 0;
		this.capacity = 4096;
		this.allocate(this.capacity);
	}

	allocate(capacity) {
		const keys = new Uint8Array(capacity * 12); // 12-byte fixed-width position key
		const columns = Array.from({ length: 6 }, () => new Int32Array(capacity));
		if (this.keys) {
			keys.set(this.keys.subarray(0, this.size * 12));
			columns.forEach((column, at) => column.set(this.columns[at].subarray(0, this.size)));
		}
		this.keys = keys;
		this.columns = columns;
	}

	push(key, move, games, whiteWins, draws, blackWins, topGameId) {
		if (this.size === this.capacity) {
			this.capacity *= 2;
			this.allocate(this.capacity);
		}
		this.keys.set(key, this.size * 12);
		const [moves, counted, white, drawn, black, top] = this.columns;
		moves[this.size] = move;
		counted[this.size] = games;
		white[this.size] = whiteWins;
		drawn[this.size] = draws;
		black[this.size] = blackWins;
		top[this.size] = topGameId;
		this.size++;
	}

	finish() {
		const [moves, games, whiteWins, draws, blackWins, topGameId] = this.columns.map((column) =>
			column.slice(0, this.size),
		);
		return {
			size: this.size,
			keys: this.keys.slice(0, this.size * 12),
			moves,
			games,
			whiteWins,
			draws,
			blackWins,
			topGameId,
		};
	}
}

function buffersOf(tree) {
	return [tree.keys, tree.moves, tree.games, tree.whiteWins, tree.draws, tree.blackWins, tree.topGameId].map(
		(array) => array.buffer,
	);
}

function sameKey(a, b) {
	for (let at = 0; at < 12; at++) {
		if (a[at] !== b[at]) return false;
	}
	return true;
}

module.exports = { countTree, buffersOf };
