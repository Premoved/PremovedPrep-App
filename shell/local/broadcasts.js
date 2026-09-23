'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');

const BASE = 'https://database.lichess.org/broadcast';
const SUMS = `${BASE}/sha256sums.txt`;

const FILE = /^lichess_db_broadcast_(\d{4}-\d{2})\.pgn\.zst$/;

async function months() {
	const response = await fetch(SUMS);
	if (!response.ok) {
		throw new Error(`The month list answered ${response.status}.`);
	}
	const text = await response.text();
	const found = [];
	for (const line of text.split('\n')) {
		const name = line.trim().split(/\s+/).at(-1) ?? '';
		const month = FILE.exec(name);
		if (month) {
			found.push(month[1]);
		}
	}
	return found.sort();
}

async function append(month, file, onProgress) {
	const url = `${BASE}/lichess_db_broadcast_${month}.pgn.zst`;
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`${month} answered ${response.status}.`);
	}

	const total = Number(response.headers.get('content-length') ?? 0);
	const part = `${file}.${month}.part`; // written first; only merged into file once fully decompressed
	let read = 0;

	const counted = new Readable({
		read() {
			// Pushed from outside; nothing to pull.
		},
	});

	const reader = response.body.getReader();
	const pump = async () => {
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				read += chunk.value.byteLength;
				onProgress?.(read, total);
				if (!counted.push(Buffer.from(chunk.value))) {
					await new Promise((resolve) => counted.once('drain', resolve));
				}
			}
			counted.push(null);
		} catch (error) {
			counted.destroy(error);
		}
	};

	const done = pipeline(counted, zlib.createZstdDecompress(), fs.createWriteStream(part));
	await Promise.all([pump(), done]);

	// A month must begin on its own line, or its first tag joins the previous month's last move.
	if (fs.existsSync(file) && fs.statSync(file).size > 0) {
		fs.appendFileSync(file, '\n');
	}
	const source = fs.createReadStream(part);
	await pipeline(source, fs.createWriteStream(file, { flags: 'a' }));
	fs.rmSync(part, { force: true });

	return fs.statSync(file).size;
}

function fileIn(parent) {
	return path.join(parent, 'Official Lichess Broadcasts.pgn');
}

module.exports = { months, append, fileIn, BASE };
