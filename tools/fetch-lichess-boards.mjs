#!/usr/bin/env node
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'public', 'board');
const SOURCE = 'https://raw.githubusercontent.com/lichess-org/lila/master/public/images/board';

// The textured boards src/app/core/board/board-themes.ts offers, as lila names them. lila's COPYING.md
// licenses all of public/images/board to "the lila authors and pirouetti" under AGPL-3.0-or-later.
// Adding one here is a licensing decision - see THIRD-PARTY.md.
const BOARDS = ['wood.jpg', 'maple.jpg'];

// CI does not need the artwork: the build is verified, not deployed. Set only in the workflow.
if (process.env.PREMOVEDPREP_SKIP_ASSETS === '1') {
	console.log('fetch-lichess-boards: PREMOVEDPREP_SKIP_ASSETS=1, nothing fetched.');
	process.exit(0);
}

async function present() {
	try {
		return await readdir(TARGET);
	} catch {
		return [];
	}
}

async function main() {
	await mkdir(TARGET, { recursive: true });
	const existing = await present();
	let missing = 0;

	for (const file of BOARDS) {
		if (existing.includes(file)) {
			console.log(`present    ${file}`);
			continue;
		}
		try {
			const response = await fetch(`${SOURCE}/${file}`);
			if (!response.ok) {
				missing++;
				console.log(`failed     ${file} (${response.status})`);
				continue;
			}
			await writeFile(join(TARGET, file), Buffer.from(await response.arrayBuffer()));
			console.log(`downloaded ${file}`);
		} catch (error) {
			// One unreachable texture must not stop the build.
			missing++;
			console.log(`failed     ${file} (${error instanceof Error ? error.message : error})`);
		}
	}

	// lila licenses the board images AGPL-3.0-or-later: the same text as this project's LICENSE.
	if (!existing.includes('LICENSE.txt')) {
		await copyFile(join(ROOT, 'LICENSE'), join(TARGET, 'LICENSE.txt'));
		console.log('written    LICENSE.txt');
	}

	if (missing > 0) {
		console.warn('Some textures are missing. Those boards fall back to their flat colours.');
	}
	console.log('Board artwork: the lila authors and pirouetti, AGPL-3.0-or-later. See THIRD-PARTY.md.');
}

main().catch((error) => {
	console.error(`fetch-lichess-boards: ${error instanceof Error ? error.message : error}`);
	process.exit(0);
});
