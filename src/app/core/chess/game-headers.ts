export interface GameHeaders {
	readonly white?: string;
	readonly whiteElo?: string;
	readonly black?: string;
	readonly blackElo?: string;
	readonly result?: string;
	readonly eco?: string;
	readonly event?: string;
	readonly site?: string;
	readonly round?: string;
	readonly date?: string;
	readonly annotator?: string;
	readonly timeControl?: string;
	readonly termination?: string;
	readonly variant?: string;
	/** Tags not modeled above, kept verbatim so copy/export doesn't silently drop them. */
	readonly extra?: Readonly<Record<string, string>>;
}

export const NO_GAME_HEADERS: GameHeaders = {};

const UNKNOWN_TAG = /^[?*.\s-]*$/;

const OWN_TAGS = new Set([
	'White',
	'WhiteElo',
	'Black',
	'BlackElo',
	'Result',
	'ECO',
	'Event',
	'Site',
	'Round',
	'Date',
	'Annotator',
	'TimeControl',
	'Termination',
	'Variant',
	'FEN',
	'SetUp',
	// Derived from the position/movetext rather than modeled, but still excluded from `extra`.
	'PlyCount',
]);

export function hasGameHeaders(headers: GameHeaders): boolean {
	return Object.values(headers).some((value) => value !== undefined);
}

export function gameHeadersFromTags(tags: Readonly<Record<string, string>>): GameHeaders {
	const read = (name: string): string | undefined => {
		const raw = tags[name]?.trim();
		return raw && !UNKNOWN_TAG.test(raw) ? raw : undefined;
	};

	return {
		white: read('White'),
		whiteElo: read('WhiteElo'),
		black: read('Black'),
		blackElo: read('BlackElo'),
		result: read('Result'),
		eco: read('ECO'),
		event: read('Event'),
		site: read('Site'),
		round: read('Round'),
		date: read('Date'),
		annotator: read('Annotator'),
		timeControl: read('TimeControl'),
		termination: read('Termination'),
		variant: read('Variant'),
		extra: extraTags(tags),
	};
}

function extraTags(tags: Readonly<Record<string, string>>): Readonly<Record<string, string>> | undefined {
	const extra: Record<string, string> = {};
	for (const [name, value] of Object.entries(tags)) {
		const trimmed = value.trim();
		if (!OWN_TAGS.has(name) && trimmed.length > 0) {
			extra[name] = trimmed;
		}
	}
	return Object.keys(extra).length > 0 ? extra : undefined;
}

export function formatGameDate(date: string | undefined): string {
	if (!date) return '';
	const [year, month, day] = date.split('.');
	return [day, month, year].filter((part) => part && !part.includes('?')).join('.');
}

export function gameHeadersLabel(headers: GameHeaders): string | null {
	if (headers.white || headers.black) {
		return `${headers.white ?? '?'} \u2013 ${headers.black ?? '?'}`;
	}
	if (headers.event) {
		return headers.annotator ? `${headers.event} \u2013 ${headers.annotator}` : headers.event;
	}
	return null;
}
