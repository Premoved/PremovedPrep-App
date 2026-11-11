/**
 * The small part of Markdown that THIRD-PARTY.md uses: headings, paragraphs, lists, tables, and inline
 * code, bold and links. Parsed into data the template draws, so nothing from the file is inserted as HTML.
 */

export interface Span {
	readonly text: string;
	readonly code?: boolean;
	readonly strong?: boolean;
	readonly href?: string;
}

export type Block =
	| { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly spans: readonly Span[] }
	| { readonly kind: 'paragraph'; readonly spans: readonly Span[] }
	| { readonly kind: 'list'; readonly items: readonly (readonly Span[])[] }
	| {
			readonly kind: 'table';
			readonly head: readonly (readonly Span[])[];
			readonly rows: readonly (readonly (readonly Span[])[])[];
	  };

export function parseNotices(text: string): readonly Block[] {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const blocks: Block[] = [];
	let at = 0;

	while (at < lines.length) {
		const line = lines[at];
		const trimmed = line.trim();

		if (trimmed.length === 0) {
			at++;
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
			blocks.push({ kind: 'heading', level, spans: inline(heading[2]) });
			at++;
			continue;
		}

		if (trimmed.startsWith('|')) {
			const rows: string[][] = [];
			while (at < lines.length && lines[at].trim().startsWith('|')) {
				rows.push(cells(lines[at]));
				at++;
			}
			const separator = rows.length > 1 && rows[1].every((cell) => /^:?-{3,}:?$/.test(cell));
			const head = separator ? rows[0] : [];
			const body = separator ? rows.slice(2) : rows;
			blocks.push({
				kind: 'table',
				head: head.map(inline),
				rows: body.map((row) => row.map(inline)),
			});
			continue;
		}

		if (/^[-*]\s+/.test(trimmed)) {
			const items: string[] = [];
			while (at < lines.length && lines[at].trim().length > 0 && !lines[at].trim().startsWith('|')) {
				const item = /^\s*[-*]\s+(.*)$/.exec(lines[at]);
				if (item) {
					items.push(item[1]);
				} else if (items.length > 0) {
					items[items.length - 1] += ` ${lines[at].trim()}`;
				}
				at++;
			}
			blocks.push({ kind: 'list', items: items.map(inline) });
			continue;
		}

		// A paragraph runs until a blank line or the start of another block; wrapped lines join with a space.
		const parts: string[] = [];
		while (at < lines.length) {
			const next = lines[at].trim();
			if (next.length === 0 || next.startsWith('#') || next.startsWith('|') || /^[-*]\s+/.test(next)) {
				break;
			}
			parts.push(next);
			at++;
		}
		blocks.push({ kind: 'paragraph', spans: inline(parts.join(' ')) });
	}

	return blocks;
}

function cells(line: string): string[] {
	const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	return inner.split('|').map((cell) => cell.trim());
}

// `code`, **bold**, [text](url) and <https://autolink>; anything else is plain text.
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>/g;

function inline(text: string): Span[] {
	const spans: Span[] = [];
	let last = 0;
	for (const match of text.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > last) {
			spans.push({ text: text.slice(last, index) });
		}
		if (match[1] !== undefined) {
			spans.push({ text: match[1], code: true });
		} else if (match[2] !== undefined) {
			spans.push(...inline(match[2]).map((span) => ({ ...span, strong: true })));
		} else if (match[3] !== undefined) {
			spans.push({ text: match[3], href: safeHref(match[4]) });
		} else if (match[5] !== undefined) {
			spans.push({ text: match[5], href: safeHref(match[5]) });
		}
		last = index + match[0].length;
	}
	if (last < text.length) {
		spans.push({ text: text.slice(last) });
	}
	return spans;
}

// Only web links become links; a relative path in the file (a repository path) stays text.
function safeHref(url: string): string | undefined {
	return /^https?:\/\//i.test(url) ? url : undefined;
}
