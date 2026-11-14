// Builds the offline player list from a list served the way the server serves it, and checks Search
// opponent's three answers against what the server gives for the same players.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { build } = require('../shell/local/player-list-worker.js');
const { Reader, METHODS, similarity } = require('../shell/local/player-queries.js');

let failures = 0;
let checks = 0;
function same(name, want, got) {
	checks++;
	if (JSON.stringify(want) !== JSON.stringify(got)) {
		failures++;
		console.error(`DIFF ${name}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
	}
}

const PLAYERS = [
	// fideId, name, fed, sex, title, std, rapid, blitz, born, active, ranks
	[2020009, 'Caruana, Fabiano', 'USA', 'M', 'GM', 2783, 2687, 2738, 1992, 1, [3, 4, 2, 2]],
	[1503014, 'Carlsen, Magnus', 'NOR', 'M', 'GM', 2833, 2827, 2885, 1990, 1, [1, 1, 1, 1]],
	[1263293, 'Botea, David-Alexandru', 'ROU', 'M', '', 1900, '', '', 2005, 1, [9, 9, 9, 9]],
	[8600001, 'Li, Bo', 'CHN', 'F', 'WFM', 2100, '', '', 1999, 0, ['', 9, '', 9]],
	[4100001, 'Öztürk, Ali', 'TUR', 'M', '', 2200, '', '', 1980, 1, [5, 5, 5, 5]],
	[4100002, 'Ozturk, Alim', 'TUR', 'M', '', 2200, '', '', 1981, 1, [5, 5, 5, 5]],
	[4100003, 'Ozturkoglu, Mehmet', 'TUR', 'M', '', 2200, '', '', 1982, 1, [5, 5, 5, 5]],
	[4100004, 'Unrated, Ozturk', 'TUR', 'F', '', '', '', '', 1983, 1, ['', '', '', '']],
];

function listText() {
	const lines = ['#premovedprep-players\t1\t20261114T145853Z'];
	for (const [id, name, fed, sex, title, std, rapid, blitz, born, active, ranks] of PLAYERS) {
		lines.push(
			['P', id, name, fed, sex, title, '', '', '', std, 0, rapid, '', blitz, '', born, active, ...ranks].join('\t'),
		);
	}
	lines.push('A\t2020009\tCaruana,F', 'A\t2020009\tCaruana Fabiano');
	return `${lines.join('\n')}\n`;
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'check-players-'));
const server = http.createServer((request, response) => {
	response.writeHead(200, { 'Content-Type': 'application/gzip' });
	response.end(zlib.gzipSync(listText()));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/app/players`;
const file = path.join(directory, 'players.sqlite');

try {
	const built = await build({ url, target: file, version: 'v' });
	same('built', { version: '20261114T145853Z', players: PLAYERS.length, aliases: 2 }, built);

	const reader = new Reader(file);
	const names = (q, limit = 20) => METHODS.search(reader, { q, limit }).map((row) => row.name);

	same('by name, any case and accent', ['Caruana, Fabiano'], names('caruana'));
	same('nickname first', ['Botea, David-Alexandru'], names('Bîtă').slice(0, 1));
	same('nickname needs its diacritics', [], names('bita'));
	same('bare FIDE id', ['Carlsen, Magnus'], names('1503014'));
	// Same rating: the closer name first, then by name; unrated last. Postgres 16 answers the same:
	// similarity() is 0.583 for "Ozturk, Alim", 0.316 for "Ozturkoglu, Mehmet", 0.059 for "Öztürk, Ali".
	same(
		'rating, then likeness, then name',
		['Ozturk, Alim', 'Ozturkoglu, Mehmet', 'Öztürk, Ali', 'Unrated, Ozturk'],
		names('ozturk'),
	);
	same('page edge keeps the closest of a tie', ['Ozturk, Alim'], names('ozturk, al', 1));
	same('two letters still search', true, names('li').includes('Li, Bo'));
	same('similarity like pg_trgm', 1, similarity('word', 'Word'));

	const caruana = METHODS.profile(reader, { fideId: 2020009 });
	same(
		'profile',
		{
			name: 'Caruana, Fabiano',
			federation: 'USA',
			standardRating: 2783,
			active: true,
			worldRankActive: 3,
			nationalRankAll: 2,
		},
		{
			name: caruana.name,
			federation: caruana.federation,
			standardRating: caruana.standardRating,
			active: caruana.active,
			worldRankActive: caruana.worldRankActive,
			nationalRankAll: caruana.nationalRankAll,
		},
	);
	same('inactive', false, METHODS.profile(reader, { fideId: 8600001 }).active);
	same(
		'identity',
		{
			keys: ['caruana|fabiano', 'caruana'],
			spellings: ['caruana, fabiano', 'caruana,f', 'caruana fabiano'],
		},
		METHODS.identity(reader, { fideId: 2020009 }),
	);
	let missing = '';
	try {
		METHODS.profile(reader, { fideId: 1 });
	} catch (error) {
		missing = error.code;
	}
	same('unknown player', 'NOT_FOUND', missing);
	reader.close();
} finally {
	server.close();
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`check-players: ${checks - failures}/${checks} ${failures === 0 ? 'OK' : 'FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
