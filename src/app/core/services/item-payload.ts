// Only moves, title and author are sealed; the rest is derived from the PGN.
export interface ItemPayload {
	readonly pgn: string;
	readonly title: string | null;
	readonly author: string | null;
}

interface StoredPayload {
	readonly v: number;
	readonly pgn: string;
	readonly title?: string | null;
	readonly author?: string | null;
}

const VERSION = 1;

export function writePayload(payload: ItemPayload): string {
	const stored: StoredPayload = { v: VERSION, pgn: payload.pgn };
	return JSON.stringify(
		payload.title === null && payload.author === null
			? stored
			: { ...stored, title: payload.title, author: payload.author },
	);
}

export function readPayload(text: string): ItemPayload {
	let parsed: StoredPayload;
	try {
		parsed = JSON.parse(text) as StoredPayload;
	} catch {
		throw new Error('This entry is stored in a form this version cannot read');
	}

	// Rejects an entry written by a future version rather than silently misreading it.
	if (typeof parsed?.pgn !== 'string' || typeof parsed.v !== 'number' || parsed.v > VERSION) {
		throw new Error('This entry is stored in a form this version cannot read');
	}

	return { pgn: parsed.pgn, title: parsed.title ?? null, author: parsed.author ?? null };
}

// Sealed in the browser: the server holds no key.
export const EMPTY_MAIN_LINE_PGN = `[Event "Main line"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]

*
`;
