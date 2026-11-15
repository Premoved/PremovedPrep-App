'use strict';

const { parentPort } = require('node:worker_threads');

const { Reader, METHODS } = require('./queries');

const PASSED_ON = new Set(['NOT_FOUND', 'BAD_REQUEST', 'UNKNOWN_METHOD', 'NO_POSITIONS']);

// One per search database, and one per search database with its positions.
const readers = new Map();

function readerFor(index, positions) {
	const name = `${index}\n${positions ?? ''}`;
	let reader = readers.get(name);
	if (!reader) {
		reader = new Reader(index, positions ?? null);
		readers.set(name, reader);
	}
	return reader;
}

parentPort.on('message', (message) => {
	if (message.type === 'close') {
		// Every reader with the file open, as the database or as its positions.
		for (const [name, reader] of [...readers]) {
			if (!name.split('\n').includes(message.index)) {
				continue;
			}
			readers.delete(name);
			try {
				reader.close();
			} catch {
				// Already closed.
			}
		}
		parentPort.postMessage({ type: 'closed', seq: message.seq });
		return;
	}

	const { seq, method, index, positions, args } = message;
	try {
		const run = Object.hasOwn(METHODS, method) ? METHODS[method] : null;
		if (!run) {
			throw Object.assign(new Error(`No such query: ${method}`), { code: 'UNKNOWN_METHOD' });
		}
		parentPort.postMessage({ type: 'result', seq, ok: true, value: run(readerFor(index, positions), args ?? {}) });
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
