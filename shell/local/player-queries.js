'use strict';

const { DatabaseSync } = require('node:sqlite');

const { fold, nameKey } = require('./layout');

// "Bîtă", typed with its diacritics, leads with the player it is the nickname of (PlayerSearchController).
const NICKNAME = 'bîtă';
const NICKNAMED = 1263293;

// The players with the rating at the edge of a page that are ranked by likeness: past this many,
// the rest keep name order.
const TIE_LIMIT = 20_000;

const SUMMARY = 'fideId, name, federation, title, standardRating';

/** One read-only connection to the offline player list. */
class Reader {
	constructor(file) {
		this.db = new DatabaseSync(file, { readOnly: true });
		this.db.exec('PRAGMA query_only = 1');
	}

	close() {
		this.db.close();
	}
}

/**
 * The same answer as GET /api/players/search: the nickname, then a bare FIDE id, then names that
 * contain the text, ignoring case and diacritics, by standard rating, then by likeness (pg_trgm's
 * similarity), then by name.
 */
function search(reader, { q, limit }) {
	const query = typeof q === 'string' ? q.trim() : '';
	if (query.length === 0) {
		return [];
	}
	const capped = Math.max(1, Math.min(Math.floor(Number(limit)) || 20, 50));
	const results = [];
	const byId = reader.db.prepare(`SELECT ${SUMMARY} FROM player WHERE fideId = ?`);

	if (query.normalize('NFC').toLowerCase() === NICKNAME) {
		push(results, byId.get(NICKNAMED));
	}
	if (/^\d+$/.test(query) && Number.isSafeInteger(Number(query))) {
		push(results, byId.get(Number(query)));
	}
	for (const row of byName(reader.db, query, capped)) {
		if (!results.some((one) => one.fideId === row.fideId)) {
			push(results, row);
		}
	}
	return results.slice(0, capped);
}

function push(results, row) {
	if (row) {
		results.push({
			fideId: row.fideId,
			name: row.name,
			federation: row.federation,
			title: row.title,
			standardRating: row.standardRating,
		});
	}
}

function byName(db, query, limit) {
	const folded = fold(query);
	const pattern = `%${folded}%`;
	// The trigram index answers three letters or more; shorter text is looked for in rating order.
	const match = [...folded].length >= 3 ? 'fideId IN (SELECT rowid FROM player_text WHERE fold LIKE ?)' : 'fold LIKE ?';

	const first = db
		.prepare(`SELECT ${SUMMARY} FROM player WHERE ${match} ORDER BY standardRating DESC NULLS LAST, name LIMIT ?`)
		.all(pattern, limit);
	if (first.length === 0) {
		return [];
	}

	// Every rating above the last one on the page is there whole; the last one may go on past it.
	const edge = first.length < limit ? undefined : first[first.length - 1].standardRating;
	let rows = first;
	if (edge !== undefined) {
		const above = first.filter((row) => row.standardRating !== edge);
		const tied = db
			.prepare(
				`SELECT ${SUMMARY} FROM player WHERE ${match} AND ${edge === null ? 'standardRating IS NULL' : 'standardRating = ?'}
				 ORDER BY name LIMIT ?`,
			)
			.all(...(edge === null ? [pattern, TIE_LIMIT] : [pattern, edge, TIE_LIMIT]));
		rows = [...above, ...tied];
	}

	const likeness = new Map(rows.map((row) => [row.fideId, similarity(row.name, query)]));
	return rows
		.sort(
			(a, b) =>
				rating(b) - rating(a) ||
				likeness.get(b.fideId) - likeness.get(a.fideId) ||
				(a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
		)
		.slice(0, limit);
}

// NULLS LAST, as on the server.
function rating(row) {
	return row.standardRating ?? -1;
}

/** pg_trgm's similarity(): shared trigrams over all trigrams of the two, words padded as it pads them. */
function similarity(left, right) {
	const one = trigrams(left);
	const two = trigrams(right);
	if (one.size === 0 && two.size === 0) {
		return 0;
	}
	let shared = 0;
	for (const gram of one) {
		if (two.has(gram)) shared++;
	}
	return shared / (one.size + two.size - shared);
}

function trigrams(text) {
	const out = new Set();
	for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (word.length === 0) continue;
		const padded = [' ', ' ', ...word, ' '];
		for (let at = 0; at + 3 <= padded.length; at++) {
			out.add(padded.slice(at, at + 3).join(''));
		}
	}
	return out;
}

/** The same answer as GET /api/search/player/{id}, but for the games in the archive, which are the server's. */
function profile(reader, { fideId }) {
	const row = reader.db.prepare('SELECT * FROM player WHERE fideId = ?').get(Number(fideId));
	if (!row) {
		throw failure('NOT_FOUND', 'No player with that FIDE id in the player list.');
	}
	return {
		fideId: row.fideId,
		name: row.name,
		federation: row.federation,
		sex: row.sex,
		title: row.title,
		wTitle: row.wTitle,
		oTitle: row.oTitle,
		foaTitle: row.foaTitle,
		standardRating: row.standardRating,
		standardGames: row.standardGames,
		rapidRating: row.rapidRating,
		rapidGames: row.rapidGames,
		blitzRating: row.blitzRating,
		blitzGames: row.blitzGames,
		birthYear: row.birthYear,
		age: row.birthYear === null ? null : new Date().getFullYear() - row.birthYear,
		active: row.active === 1,
		archiveGames: 0,
		peakArchiveElo: null,
		archiveName: '',
		worldRankActive: row.worldActive,
		worldRankAll: row.worldAll,
		nationalRankActive: row.nationalActive,
		nationalRankAll: row.nationalAll,
	};
}

/** The same answer as GET /api/search/player/{id}/identity: the player's names and learned spellings. */
function identity(reader, { fideId }) {
	const id = Number(fideId);
	const names = [
		...reader.db.prepare('SELECT name FROM player WHERE fideId = ?').all(id),
		...reader.db.prepare('SELECT name FROM alias WHERE fideId = ?').all(id),
	].map((row) => row.name);
	const keys = [];
	const spellings = [];
	for (const name of names) {
		if (typeof name !== 'string' || name.trim().length === 0) continue;
		const spelling = name.trim().toLowerCase();
		if (!spellings.includes(spelling)) spellings.push(spelling);
		const key = nameKey(name);
		if (key && !keys.includes(key)) keys.push(key);
	}
	return { keys, spellings };
}

function failure(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

const METHODS = { search, profile, identity };

module.exports = { Reader, METHODS, similarity };
