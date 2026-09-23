#!/usr/bin/env node
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'public', 'piece');
const SOURCE = 'https://raw.githubusercontent.com/lichess-org/lila/master/public/piece';

const FILES = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];

// Only sets whose licence permits commercial redistribution, per lila's COPYING.md; CC BY-NC-SA and
// non-free sets are deliberately absent. Adding one here is a licensing decision - see THIRD-PARTY.md.
const SETS = [
	'cburnett',
	'celtic',
	'chessnut',
	'fantasy',
	'kiwen-suwi',
	'letter',
	'merida',
	'mpchess',
	'papercut',
	'pirouetti',
	'pixel',
	'rhosgfx',
	'shapes',
	'spatial',
	'totoy',
];

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

async function readInstalled() {
	let entries;
	try {
		entries = await readdir(TARGET, { withFileTypes: true });
	} catch {
		return [];
	}

	const installed = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (await alreadyComplete(entry.name)) {
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
