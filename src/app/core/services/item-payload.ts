import { withLegacyNames } from '../chess/pgn-metadata';

// Only the PGN is sealed; every column is derived from its tags.
export interface ItemPayload {
	readonly pgn: string;
}

interface StoredPayload {
	readonly v: number;
	readonly pgn: string;
	// Written by builds that kept a title and an author beside the PGN; read, never written.
	readonly title?: string | null;
	readonly author?: string | null;
}

const VERSION = 1;

export function writePayload(payload: ItemPayload): string {
	const stored: StoredPayload = { v: VERSION, pgn: payload.pgn };
	return JSON.stringify(stored);
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

	return { pgn: withLegacyNames(parsed.pgn, parsed.title, parsed.author) };
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
