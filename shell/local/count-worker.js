'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const { countTree, buffersOf } = require('./tree-count');

// Read-only: the indexer thread is the sole writer to this table.
const db = new DatabaseSync(workerData.index, { readOnly: true });
db.exec('PRAGMA cache_size = -65536');
const result = new Uint8Array(workerData.result);
const rank = new Int32Array(workerData.rank);

parentPort.on('message', ({ bucket, table }) => {
	try {
		const tree = countTree(db, table, result, rank);
		parentPort.postMessage({ bucket, tree }, buffersOf(tree));
	} catch (error) {
		parentPort.postMessage({ bucket, error: error instanceof Error ? error.message : String(error) });
	}
});
