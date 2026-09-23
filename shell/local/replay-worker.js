'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { replay } = require('./replay');
const { sanTokens } = require('./pgn-stream');

const { maxPly } = workerData;

parentPort.on('message', (games) => {
	try {
		const plies = new Int32Array(games.length);
		const counts = new Int32Array(games.length);
		const keys = [];
		const sans = [];
		const ucis = [];

		for (let at = 0; at < games.length; at++) {
			const tokens = sanTokens(games[at].moves);
			plies[at] = tokens.length;
			counts[at] = replay(tokens, games[at].fen, maxPly, (key, san, uci) => {
				keys.push(key);
				sans.push(san);
				ucis.push(uci);
			});
		}

		const flat = new Uint8Array(keys.length * 12); // 12-byte fixed-width position key
		for (let at = 0; at < keys.length; at++) {
			flat.set(keys[at], at * 12);
		}

		parentPort.postMessage({ plies, counts, keys: flat, sans, ucis }, [plies.buffer, counts.buffer, flat.buffer]);
	} catch (error) {
		parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
});
