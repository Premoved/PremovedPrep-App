#!/usr/bin/env node
// Installs the Stockfish build for this machine where shell/main.js looks for it. The binary is
// GPL-3.0-or-later and stays out of the repository; Copying.txt and AUTHORS sit beside it.

import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const RELEASES = 'https://api.github.com/repos/official-stockfish/Stockfish/releases';

// Pinned: `latest` moves, and two builds of one tag must ship the same engine.
const TAG = 'sf_19';

// Asset name to SHA-256. Unlisted: installed, hash printed. Listed: must match.
const KNOWN = {};

// Most wanted first. Stockfish renamed its assets at 19, so both schemes are listed.
const WANTED = {
	'win32-x64': [
		/^stockfish-windows-x86-64-universal\./,
		/^stockfish-windows-x86-64\./,
		/^stockfish-windows-x86-64-avx2\./,
	],
	'win32-arm64': [/^stockfish-windows-arm64-universal\./, /^stockfish-windows-x86-64-universal\./],
	'darwin-arm64': [/^stockfish-macos-universal\./, /^stockfish-macos-m1-apple-silicon\./],
	'darwin-x64': [/^stockfish-macos-universal\./, /^stockfish-macos-x86-64\./, /^stockfish-macos-x86-64-avx2\./],
	'linux-x64': [
		/^stockfish-linux-x86-64-universal\./,
		/^stockfish-ubuntu-x86-64-universal\./,
		/^stockfish-ubuntu-x86-64\./,
		/^stockfish-ubuntu-x86-64-avx2\./,
	],
	'linux-arm64': [/^stockfish-linux-arm64-universal\./],
};

const target = `${process.platform}-${process.arch}`;
const patterns = WANTED[target];
if (!patterns) {
	fail(`No Stockfish build is known for ${target}. Put the binary in resources/engines/${target}/ by hand.`);
}

const release = await pick(process.argv[2] ?? TAG);
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
await verify(archive, asset.name);
await extract(archive, work);

const binary = await findBinary(work, archive);
const into = path.join('resources', 'engines', target);
await mkdir(into, { recursive: true });
const installed = path.join(into, process.platform === 'win32' ? 'stockfish.exe' : 'stockfish');
await move(binary, installed);
await chmod(installed, 0o755);
await rm(work, { recursive: true, force: true });
console.log(`Installed ${installed} (${((await stat(installed)).size / 1e6).toFixed(0)} MB)`);

// The temporary directory is often another filesystem, where rename fails with EXDEV.
async function move(from, to) {
	try {
		await rename(from, to);
	} catch (error) {
		if (error.code !== 'EXDEV') {
			throw error;
		}
		await copyFile(from, to);
		await unlink(from);
	}
}

async function verify(file, name) {
	const hash = createHash('sha256');
	await pipeline(createReadStream(file), hash);
	const digest = hash.digest('hex');
	const expected = KNOWN[name];
	if (expected && expected !== digest) {
		fail(`${name} hashes to ${digest}, not the recorded ${expected}.`);
	}
	console.log(`sha256 ${digest}${expected ? ' (matches)' : ' (not recorded yet)'}`);
}

// Unauthenticated calls are rate limited per IP, which a hosted runner shares: 403 without a token.
async function pick(tag) {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
	const where = tag === 'latest' ? `${RELEASES}/latest` : `${RELEASES}/tags/${tag}`;
	const response = await fetch(where, {
		headers: {
			'user-agent': 'premovedprep-build',
			accept: 'application/vnd.github+json',
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
	if (!response.ok) {
		const remaining = response.headers.get('x-ratelimit-remaining');
		const rate = remaining === '0' ? ' The rate limit is spent; set GITHUB_TOKEN.' : '';
		fail(`GitHub answered ${response.status} for the Stockfish release list.${rate}`);
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

// The downloaded archive shares the `stockfish-` prefix, so it is excluded by path.
async function findBinary(root, archive) {
	const stack = [root];
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (full !== archive && /^stockfish(-[\w-]+)?(\.exe)?$/i.test(entry.name)) {
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
