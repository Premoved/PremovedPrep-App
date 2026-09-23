#!/usr/bin/env node
// Downloads the Stockfish build for this machine into resources/engines/<platform>-<arch>/,
// where shell/main.js looks for it. Nothing is committed: a GPL binary travels with its own
// licence, and Copying.txt and AUTHORS are already beside it in that folder.
//
//   node tools/fetch-engine.mjs            latest release
//   node tools/fetch-engine.mjs sf_17.1    a named tag

import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const RELEASES = 'https://api.github.com/repos/official-stockfish/Stockfish/releases';

// The asset for this machine, most wanted first: a build that picks its instruction set at run
// time, then the plain 64-bit one.
const WANTED = {
	'win32-x64': [/^stockfish-windows-x86-64-universal\./, /^stockfish-windows-x86-64\./],
	'win32-arm64': [/^stockfish-windows-x86-64-universal\./],
	'darwin-arm64': [/^stockfish-macos-m1-apple-silicon\./, /^stockfish-macos-x86-64-universal\./],
	'darwin-x64': [/^stockfish-macos-x86-64-universal\./, /^stockfish-macos-x86-64\./],
	'linux-x64': [/^stockfish-ubuntu-x86-64-universal\./, /^stockfish-ubuntu-x86-64\./],
};

const target = `${process.platform}-${process.arch}`;
const patterns = WANTED[target];
if (!patterns) {
	fail(`No Stockfish build is known for ${target}. Put the binary in resources/engines/${target}/ by hand.`);
}

const release = await pick(process.argv[2]);
const asset = patterns.map((p) => release.assets.find((a) => p.test(a.name))).find(Boolean);
if (!asset) {
	fail(
		`Release ${release.tag_name} has no asset for ${target}. Assets: ${release.assets.map((a) => a.name).join(', ')}`,
	);
}

const work = await mkdtemp(path.join(tmpdir(), 'premoved-engine-'));
const archive = path.join(work, asset.name);
console.log(`${release.tag_name}: ${asset.name}`);
await download(asset.browser_download_url, archive);
await extract(archive, work);

const binary = await findBinary(work);
const into = path.join('resources', 'engines', target);
await mkdir(into, { recursive: true });
const installed = path.join(into, process.platform === 'win32' ? 'stockfish.exe' : 'stockfish');
await rename(binary, installed);
await chmod(installed, 0o755);
await rm(work, { recursive: true, force: true });
console.log(`Installed ${installed} (${((await stat(installed)).size / 1e6).toFixed(0)} MB)`);

async function pick(tag) {
	const response = await fetch(tag ? `${RELEASES}/tags/${tag}` : `${RELEASES}/latest`, {
		headers: { 'user-agent': 'premovedprep-build', accept: 'application/vnd.github+json' },
	});
	if (!response.ok) {
		fail(`GitHub answered ${response.status} for the Stockfish release list.`);
	}
	return response.json();
}

async function download(url, to) {
	const response = await fetch(url, { headers: { 'user-agent': 'premovedprep-build' }, redirect: 'follow' });
	if (!response.ok || !response.body) {
		fail(`Downloading ${url} answered ${response.status}.`);
	}
	await pipeline(response.body, createWriteStream(to));
}

async function extract(archive, into) {
	// tar handles .tar and .zip on every platform this script supports (Windows 10+ ships bsdtar).
	execFileSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
}

// The archives unpack into a `stockfish/` directory whose binary is the only executable file.
async function findBinary(root) {
	const stack = [root];
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (/^stockfish(-[\w.-]+)?(\.exe)?$/i.test(entry.name)) {
				return full;
			}
		}
	}
	fail('The archive held no stockfish binary.');
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
