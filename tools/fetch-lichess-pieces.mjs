#!/usr/bin/env node
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'public', 'piece');
const SOURCE = 'https://raw.githubusercontent.com/lichess-org/lila/master/public/piece';

const FILES = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];

// Only sets whose licence permits commercial redistribution, per lila's COPYING.md; CC BY-NC-SA and
// non-free sets are deliberately absent. Adding one here is a licensing decision - see THIRD-PARTY.md.
const SETS = ['cburnett', 'chessnut', 'fantasy', 'merida', 'spatial'];

// Each set's licence text, written beside its artwork as LICENSE.txt. The MIT and Apache texts are the
// authors' own files (they carry the copyright line); NOTICE is copied too where the author ships one.
const GPL_2 = { local: join(ROOT, 'licenses', 'GPL-2.0.txt') };
const CHESS_ART = { url: 'https://raw.githubusercontent.com/maurimo/chess-art/main/LICENSE' };
const LICENCES = {
	cburnett: GPL_2,
	merida: GPL_2,
	chessnut: {
		url: 'https://raw.githubusercontent.com/LexLuengas/chessnut-pieces/master/LICENSE.txt',
		notice: 'https://raw.githubusercontent.com/LexLuengas/chessnut-pieces/master/NOTICE',
	},
	fantasy: CHESS_ART,
	spatial: CHESS_ART,
};

// CI does not need the artwork: the build is verified, not deployed. Set only in the workflow.
if (process.env.PREMOVEDPREP_SKIP_ASSETS === '1') {
	console.log('fetch-lichess-pieces: PREMOVEDPREP_SKIP_ASSETS=1, nothing fetched.');
	process.exit(0);
}

const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const wanted = requested.length > 0 ? requested : SETS;

async function alreadyComplete(set) {
	try {
		const entries = await readdir(join(TARGET, set));
		return FILES.every((name) => entries.includes(`${name}.svg`));
	} catch {
		return false;
	}
}

async function fetchSet(set) {
	if (await alreadyComplete(set)) {
		return { set, status: 'present' };
	}

	await mkdir(join(TARGET, set), { recursive: true });

	for (const name of FILES) {
		const response = await fetch(`${SOURCE}/${set}/${name}.svg`);
		if (!response.ok) {
			return { set, status: 'incomplete', detail: `${name}.svg -> ${response.status}` };
		}
		await writeFile(join(TARGET, set, `${name}.svg`), await response.text(), 'utf8');
	}

	return { set, status: 'downloaded' };
}

async function writeLicence(set) {
	const licence = LICENCES[set];
	const folder = join(TARGET, set);
	const existing = await readdir(folder).catch(() => []);
	if (existing.includes('LICENSE.txt')) return 'present';

	if (licence.local) {
		await copyFile(licence.local, join(folder, 'LICENSE.txt'));
		return 'written';
	}

	const response = await fetch(licence.url);
	if (!response.ok) return `missing (${response.status})`;
	await writeFile(join(folder, 'LICENSE.txt'), await response.text(), 'utf8');

	if (licence.notice) {
		const notice = await fetch(licence.notice);
		if (notice.ok) await writeFile(join(folder, 'NOTICE.txt'), await notice.text(), 'utf8');
	}
	return 'written';
}

async function readInstalled() {
	let entries;
	try {
		entries = await readdir(TARGET, { withFileTypes: true });
	} catch {
		return [];
	}

	const installed = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !SETS.includes(entry.name)) continue;
		const files = await readdir(join(TARGET, entry.name));
		if ((await alreadyComplete(entry.name)) && files.includes('LICENSE.txt')) {
			installed.push(entry.name);
		}
	}
	return installed.sort();
}

async function main() {
	await mkdir(TARGET, { recursive: true });

	for (const set of wanted) {
		let result;
		try {
			result = await fetchSet(set);
		} catch (error) {
			// One unreachable set must not stop the rest, or the build.
			result = { set, status: 'failed', detail: error instanceof Error ? error.message : String(error) };
		}
		const suffix = result.detail ? ` (${result.detail})` : '';
		console.log(`${result.status.padEnd(10)} ${result.set}${suffix}`);

		if (result.status === 'present' || result.status === 'downloaded') {
			const licence = await writeLicence(set).catch(
				(error) => `missing (${error instanceof Error ? error.message : error})`,
			);
			console.log(`           ${set}/LICENSE.txt ${licence}`);
		}
	}

	const sets = await readInstalled();
	await writeFile(join(TARGET, 'manifest.json'), `${JSON.stringify({ source: SOURCE, sets }, null, '\t')}\n`, 'utf8');

	console.log(`\n${sets.length} set(s) installed. Manifest written to public/piece/manifest.json.`);
	if (sets.length < wanted.length) {
		console.warn('Some sets are missing. The board still works: cburnett ships inside @lichess-org/chessground,');
		console.warn('and the settings page offers only what the manifest lists.');
	}
	console.log('Artwork belongs to its authors. Per-set licences are in THIRD-PARTY.md.');
}

// The manifest is always written, so a failure here degrades the piece list rather than failing the build.
await main().catch((error) => {
	console.error(`fetch-lichess-pieces: ${error instanceof Error ? error.message : error}`);
});
