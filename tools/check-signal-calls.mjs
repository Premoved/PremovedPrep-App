#!/usr/bin/env node
// Fails if a template reads a signal without calling it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const SRC = 'src/app';

// Signals exposed by injected services, read in templates as `service.name()`.
const SERVICE_SIGNALS = [
	'isMobile',
	'isNarrow',
	'squareSize',
	'floorWidth',
	'ceilingWidth',
	'actionsBarHeight',
	'setupStickToBoardTop',
	'setupBottomOffset',
	'isAtRoot',
	'canGoForward',
	'drawingsVisible',
	'currentNode',
	'root',
	'headers',
	'revision',
	'pieceSet',
	'boardThemeId',
	'coordinates',
	'arrowColors',
	'moveDests',
	'sound',
	'customColors',
	'installedPieceSets',
	'dirty',
	'atDefaults',
	'inRange',
	'status',
];

const DECLARATION =
	/^\s*(?:(?:readonly|protected|private|public|static)\s+)*(\w+)\s*=\s*(?:signal|computed|input|model)\s*[(<]/gm;
const EXPRESSION = /(?:\[[\w.\-$]+\]|\(\w[\w.\-]*\)|\*[\w-]+)="([^"]*)"|\{\{([^}]*)\}\}/g;

function walk(dir) {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

const problems = [];
let checkedTemplates = 0;

for (const tsPath of walk(SRC).filter((p) => p.endsWith('.component.ts'))) {
	const htmlPath = join(dirname(tsPath), basename(tsPath).replace(/\.ts$/, '.html'));
	let template;
	try {
		template = readFileSync(htmlPath, 'utf8');
	} catch {
		continue; // inline template, nothing to scan
	}
	checkedTemplates++;

	const source = readFileSync(tsPath, 'utf8');
	const names = [...source.matchAll(DECLARATION)].map((m) => m[1]);
	const lineOf = (index) => template.slice(0, index).split('\n').length;

	for (const match of template.matchAll(EXPRESSION)) {
		const expression = match[1] ?? match[2];
		const report = (name) =>
			problems.push({ file: htmlPath, line: lineOf(match.index), name, expression: expression.trim() });

		// String literals are blanked so quoted prose can't match a signal name.
		const code = expression.replace(/'[^']*'/g, (literal) => ' '.repeat(literal.length));

		for (const name of names) {
			// Not preceded by a word char, dot, hyphen or $: skips `.name` and `other-name` matches.
			for (const hit of code.matchAll(new RegExp(`(?<![\\w.\\-$])${name}(?![\\w\\-$])`, 'g'))) {
				const rest = code.slice(hit.index + name.length);
				if (/^(\(|\.set\(|\.update\()/.test(rest)) continue;
				report(name);
			}
		}

		for (const name of SERVICE_SIGNALS) {
			for (const hit of code.matchAll(new RegExp(`\\.${name}(?![\\w\\-$(])`, 'g'))) {
				void hit;
				report(`.${name}`);
			}
		}
	}
}

if (problems.length === 0) {
	console.log(`check-signal-calls: OK (${checkedTemplates} templates)`);
	process.exit(0);
}

for (const { file, line, name, expression } of problems) {
	console.error(`${file}:${line}  \`${name}\` is read but never called   in  ${expression}`);
}
console.error(`\ncheck-signal-calls: ${problems.length} problem(s)`);
process.exit(1);
