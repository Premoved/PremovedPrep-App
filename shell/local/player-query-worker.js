'use strict';

const { parentPort } = require('node:worker_threads');

const { Reader, METHODS } = require('./player-queries');

// Same protocol as query-worker.js, for the offline player list.
const PASSED_ON = new Set(['NOT_FOUND', 'BAD_REQUEST', 'UNKNOWN_METHOD']);

const readers = new Map();

function readerFor(file) {
	let reader = readers.get(file);
	if (!reader) {
		reader = new Reader(file);
		readers.set(file, reader);
	}
	return reader;
}

parentPort.on('message', (message) => {
	if (message.type === 'close') {
		const reader = readers.get(message.index);
		readers.delete(message.index);
		try {
			reader?.close();
		} catch {
			// Already closed.
		}
		parentPort.postMessage({ type: 'closed', seq: message.seq });
		return;
	}

	const { seq, method, index, args } = message;
	try {
		const run = Object.hasOwn(METHODS, method) ? METHODS[method] : null;
		if (!run) {
			throw Object.assign(new Error(`No such query: ${method}`), { code: 'UNKNOWN_METHOD' });
		}
		parentPort.postMessage({ type: 'result', seq, ok: true, value: run(readerFor(index), args ?? {}) });
	} catch (error) {
		parentPort.postMessage({
			type: 'result',
			seq,
			ok: false,
			code: PASSED_ON.has(error?.code) ? error.code : 'FAILED',
			message: error?.message ?? String(error),
		});
	}
});
