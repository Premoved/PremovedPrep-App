'use strict';

const fs = require('node:fs');

const TAG = /^\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/;

async function* readLines(file, from = 0, chunkSize = 1 << 20) {
	const stream = fs.createReadStream(file, { start: from, highWaterMark: chunkSize });

	let held = Buffer.alloc(0);
	let base = from;

	for await (const chunk of stream) {
		held = held.length === 0 ? chunk : Buffer.concat([held, chunk]);

		let from = 0;
		let at = held.indexOf(0x0a, from);
		while (at !== -1) {
			yield { text: decode(held, from, at), start: base + from, end: base + at + 1 };
			from = at + 1;
			at = held.indexOf(0x0a, from);
		}

		base += from;
		held = from === 0 ? held : held.subarray(from);
	}

	if (held.length > 0) {
		yield { text: decode(held, 0, held.length), start: base, end: base + held.length };
	}
}

function decode(buffer, from, to) {
	const end = to > from && buffer[to - 1] === 0x0d ? to - 1 : to;
	return buffer.toString('utf8', from, end);
}

async function* readGames(file, from = 0) {
	let tags = {};
	let moves = [];
	let start = null;
	let end = 0;
	let inMoves = false;

	for await (const line of readLines(file, from)) {
		const trimmed = line.text.trim();
		const isTag = trimmed.startsWith('[') && TAG.test(trimmed);

		// A game ends where the next one's first tag begins.
		if (isTag && inMoves) {
			yield { tags, moves: moves.join(' '), offset: start, length: end - start };
			tags = {};
			moves = [];
			start = null;
			inMoves = false;
		}

		if (start === null) {
			if (trimmed.length === 0) continue;
			start = line.start;
		}

		if (isTag) {
			const found = TAG.exec(trimmed);
			tags[found[1]] = found[2].replace(/\\(["\\])/g, '$1');
		} else if (trimmed.length > 0) {
			inMoves = true;
			moves.push(trimmed);
		}

		end = line.end;
	}

	if (start !== null && (inMoves || Object.keys(tags).length > 0)) {
		yield { tags, moves: moves.join(' '), offset: start, length: end - start };
	}
}

function sanTokens(movetext) {
	const out = [];
	let at = 0;
	let depth = 0;

	while (at < movetext.length) {
		const ch = movetext[at];

		if (ch === '{') {
			const close = movetext.indexOf('}', at);
			at = close === -1 ? movetext.length : close + 1;
			continue;
		}
		if (ch === ';') {
			const close = movetext.indexOf('\n', at);
			at = close === -1 ? movetext.length : close + 1;
			continue;
		}
		if (ch === '(') {
			depth++;
			at++;
			continue;
		}
		if (ch === ')') {
			depth = Math.max(0, depth - 1);
			at++;
			continue;
		}
		if (/\s/.test(ch)) {
			at++;
			continue;
		}

		let to = at;
		while (to < movetext.length && !/[\s{;()]/.test(movetext[to])) to++;
		const token = movetext.slice(at, to);
		at = to;

		if (depth > 0) continue;
		if (token === '*' || token === '1-0' || token === '0-1' || token === '1/2-1/2') continue;
		if (token.startsWith('$')) continue;
		// "12." and "12..." are numbering; "12.e4" carries a move behind it.
		const move = token.replace(/^\d+\.+/, '');
		if (move.length === 0) continue;
		out.push(move);
	}

	return out;
}

module.exports = { readGames, readLines, sanTokens };
