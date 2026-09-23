// Checks that every [input]/(output) used in a template exists on the target component, and that no
// template reference variable shadows a class member.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = process.argv[2] ?? 'src';

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			out.push(...walk(path));
		} else {
			out.push(path);
		}
	}
	return out;
}

const files = walk(ROOT);
const tsFiles = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

// selector -> { file, inputs, outputs, className }
const bySelector = new Map();
// file -> component record
const byFile = new Map();

for (const file of tsFiles) {
	const source = readFileSync(file, 'utf8');
	if (!source.includes('@Component')) continue;

	const selector = source.match(/selector:\s*'([^']+)'/)?.[1];
	const className = source.match(/export class (\w+)/)?.[1];
	if (!selector || !className) continue;

	const inputs = new Set();
	for (const m of source.matchAll(/(?:readonly\s+)?(\w+)\s*=\s*(?:input|model)(?:\.required)?\s*[<(]/g)) {
		inputs.add(m[1]);
	}
	for (const m of source.matchAll(/@Input\([^)]*\)\s*(?:readonly\s+)?(?:set\s+|get\s+)?(\w+)/g)) {
		inputs.add(m[1]);
	}
	for (const m of source.matchAll(/alias:\s*'([^']+)'/g)) {
		inputs.add(m[1]);
	}

	const outputs = new Set();
	for (const m of source.matchAll(/(?:readonly\s+)?(\w+)\s*=\s*(?:output|model)(?:\.required)?\s*[<(]/g)) {
		outputs.add(m[1]);
	}
	for (const m of source.matchAll(/@Output\([^)]*\)\s*(?:readonly\s+)?(?:get\s+)?(\w+)/g)) {
		outputs.add(m[1]);
	}

	const importsBlock = source.match(/imports:\s*\[([^\]]*)\]/s)?.[1] ?? '';
	const imported = new Set(
		importsBlock
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
	);

	const importPaths = new Map();
	for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
		for (const name of m[1].split(',').map((s) => s.trim().split(' as ').pop().trim())) {
			importPaths.set(name, m[2]);
		}
	}

	const templateUrl = source.match(/templateUrl:\s*'([^']+)'/)?.[1];
	const inlineTemplate = source.match(/template:\s*`([\s\S]*?)`\s*,\n/)?.[1];

	// Every name declared on the class, for the shadowing check below.
	const members = new Set();
	for (const m of source.matchAll(
		/^\t(?:(?:private|protected|public|readonly|static|async|override)\s+)*(\w+)\s*[=(]/gm,
	)) {
		members.add(m[1]);
	}
	for (const m of source.matchAll(
		/@(?:ViewChild|ViewChildren|ContentChild|ContentChildren)\([^)]*\)\s*(?:(?:private|protected|public|readonly)\s+)*(\w+)/g,
	)) {
		members.add(m[1]);
	}

	const record = {
		file,
		selector,
		className,
		inputs,
		outputs,
		members,
		imported,
		importPaths,
		templateUrl,
		inlineTemplate,
	};
	bySelector.set(selector, record);
	byFile.set(resolve(file), record);
}

const problems = [];

for (const component of byFile.values()) {
	let template = component.inlineTemplate;
	let where = component.file;

	if (component.templateUrl) {
		const path = resolve(dirname(component.file), component.templateUrl);
		try {
			template = readFileSync(path, 'utf8');
			where = path;
		} catch {
			problems.push(`${component.file}: templateUrl '${component.templateUrl}' does not exist`);
			continue;
		}
	}
	if (!template) continue;

	// Template reference variables (#foo) that shadow a member of this component's class.
	const refs = new Set();
	for (const m of template.matchAll(/\s#(\w+)[\s=/>]/g)) {
		refs.add(m[1]);
	}
	for (const name of refs) {
		if (!component.members.has(name)) continue;
		if (!new RegExp(`="[^"]*\\b${name}\\s*\\(`).test(template)) continue;

		problems.push(
			`${where}\n    #${name} shadows ${component.className}.${name}, and the template calls ` +
				`${name}(...)\n` +
				`    inside a template the reference wins, so this is the element - not the member. ` +
				`Rename one of the two,\n    or put the call behind a method on the component.`,
		);
	}

	for (const tag of template.matchAll(/<(app-[\w-]+)((?:\s+[^>]*?)?)\/?>/g)) {
		const [, selector, attrs] = tag;
		const target = bySelector.get(selector);

		if (!target) {
			continue;
		}

		if (!component.imported.has(target.className)) {
			problems.push(
				`${where}\n    <${selector}> is used but ${target.className} is not in ` +
					`${component.className}'s imports  [NG8001]`,
			);
		}

		for (const bind of attrs.matchAll(/\[([\w.$]+)\]\s*=/g)) {
			const prop = bind[1];
			if (
				prop.startsWith('class') ||
				prop.startsWith('style') ||
				prop.startsWith('attr') ||
				prop === 'ngIf' ||
				prop === 'ngForOf' ||
				prop === 'ngClass' ||
				prop === 'ngStyle' ||
				prop === 'id' ||
				prop === 'title' ||
				prop === 'hidden' ||
				prop === 'disabled'
			) {
				continue;
			}
			if (!target.inputs.has(prop)) {
				problems.push(
					`${where}\n    [${prop}] on <${selector}> is not an input of ${target.className}  [NG8002]\n` +
						`    it has: ${[...target.inputs].join(', ') || '(none found)'}`,
				);
			}
		}

		for (const bind of attrs.matchAll(/\((\w+)\)\s*=/g)) {
			const event = bind[1];
			if (
				[
					'click',
					'change',
					'input',
					'focus',
					'blur',
					'keydown',
					'keyup',
					'submit',
					'pointerdown',
					'pointerup',
					'pointermove',
					'mouseenter',
					'mouseleave',
					'contextmenu',
					'wheel',
					'scroll',
					'dragstart',
					'dragover',
					'drop',
					'dragend',
					'dragleave',
					'dragenter',
				].includes(event)
			) {
				continue;
			}
			if (!target.outputs.has(event) && !target.inputs.has(event.replace(/Change$/, ''))) {
				problems.push(
					`${where}\n    (${event}) on <${selector}> is not an output of ${target.className}\n` +
						`    it has: ${[...target.outputs].join(', ') || '(none found)'}`,
				);
			}
		}
	}
}

console.log(`components: ${bySelector.size}   templates checked: ${byFile.size}`);
if (problems.length === 0) {
	console.log('\nNo binding problems found.');
} else {
	console.log(`\n${problems.length} problem(s):\n`);
	for (const problem of problems) console.log('  ' + problem + '\n');
	process.exitCode = 1;
}
