/**
 * Time controls, read the way players say them ("90 min + 30 sec") and written the way PGN stores
 * them ("5400+30"). A game keeps both: TimeControlName for people, TimeControl for software
 * (Lichess, ChessBase and the rest read only the second).
 *
 * TimeControl follows the PGN standard (section 9.6.1): periods separated by ":", each one
 * "moves/seconds" or "seconds", with "+increment" in seconds where the period has one. A single
 * period with no move count is written "seconds+increment", "600+0" included, as Lichess does.
 */

export type TimeControlCategory = 'Classical' | 'Fast classical' | 'Rapid' | 'Blitz';

export interface TimeControlPreset {
	readonly category: TimeControlCategory;
	readonly name: string;
	readonly pgn: string;
}

/**
 * The time controls FIDE itself prescribes, from its current regulations:
 * - 120/40 + 30, +30 sec from move 41: World Championship Match 2024 and 2026, Candidates 2026.
 * - 90/40 + 30, +30 sec: Olympiad, World Cup and FIDE's other world events.
 * - 90 + 30: the traditional minimum for high-level classical events.
 * - 60 + 30 and 45 + 30: the shorter classical controls FIDE approved in 2026.
 * - 15 + 10 and 10 + 5: World Rapid Championship, and the rapid tie-breaks of the title events.
 * - 3 + 2: World Blitz Championship, and the blitz tie-breaks.
 */
export const FIDE_TIME_CONTROLS: readonly TimeControlPreset[] = [
	{ category: 'Classical', name: '120 min / 40 moves + 30 min, +30 sec from move 41', pgn: '40/7200:1800+30' },
	{ category: 'Classical', name: '90 min / 40 moves + 30 min, +30 sec', pgn: '40/5400+30:1800+30' },
	{ category: 'Classical', name: '90 min + 30 sec', pgn: '5400+30' },
	{ category: 'Fast classical', name: '60 min + 30 sec', pgn: '3600+30' },
	{ category: 'Fast classical', name: '45 min + 30 sec', pgn: '2700+30' },
	{ category: 'Rapid', name: '15 min + 10 sec', pgn: '900+10' },
	{ category: 'Rapid', name: '10 min + 5 sec', pgn: '600+5' },
	{ category: 'Blitz', name: '3 min + 2 sec', pgn: '180+2' },
];

export const TIME_CONTROL_CATEGORIES: readonly TimeControlCategory[] = [
	'Classical',
	'Fast classical',
	'Rapid',
	'Blitz',
];

interface Period {
	/** Moves this period is for; null for the rest of the game. */
	readonly moves: number | null;
	readonly seconds: number;
	readonly increment: number;
}

// The largest values taken: anything above is a typo, not a time control.
const MAX_SECONDS = 24 * 3600;
const MAX_INCREMENT = 3600;
const MAX_MOVES = 500;

/**
 * The PGN TimeControl for a time control written as players write it, or null when the text is not
 * one: the text is then kept as the game's TimeControlName only.
 *
 * Understood:
 * - "15+10", "15 + 10", "15 min + 10 sec", "15' + 10\"": minutes, then an increment in seconds.
 * - "90 min", "90": one period, no increment.
 * - "90 min / 40 moves + 30 min + 30 sec", "90/40 + 30 + 30s": periods as FIDE writes them,
 *   minutes first and the moves after the slash; the last number is the increment when marked as
 *   seconds, or when it follows a period that already has its minutes.
 * - "... + 30 sec from move 41": an increment only from that move on.
 * - "30 sec + 1 sec": a period given in seconds.
 */
export function parseTimeControl(text: string): string | null {
	const periods = periodsOf(text);
	return periods === null ? null : pgnOf(periods);
}

/** The natural reading of a PGN TimeControl, or null when it is not one this module can read. */
export function describeTimeControl(pgn: string | null | undefined): string | null {
	const value = pgn?.trim();
	if (!value) {
		return null;
	}
	const preset = FIDE_TIME_CONTROLS.find((one) => one.pgn === value);
	if (preset) {
		return preset.name;
	}
	const periods = pgnPeriods(value);
	return periods === null ? null : nameOf(periods);
}

/** What a game's header shows: its own name, else the reading of its TimeControl, else the tag as written. */
export function timeControlLabel(name: string | null | undefined, pgn: string | null | undefined): string | null {
	return name?.trim() || describeTimeControl(pgn) || pgn?.trim() || null;
}

/** The PGN TimeControl a saved or chosen text stands for: a preset's own value, or the text read. */
export function pgnForName(name: string): string | null {
	const preset = FIDE_TIME_CONTROLS.find((one) => one.name === name.trim());
	return preset ? preset.pgn : parseTimeControl(name);
}

type Unit = 'min' | 'sec' | 'moves' | null;

interface Term {
	readonly value: number;
	readonly unit: Unit;
	/** Moves after a slash: "90/40". */
	readonly moves: number | null;
	/** "from move 41". */
	readonly fromMove: number | null;
}

const UNITS: readonly [RegExp, Unit][] = [
	[/^(?:minutes?|mins?|m|')$/, 'min'],
	[/^(?:seconds?|secs?|s|")$/, 'sec'],
	[/^(?:moves?|mv)$/, 'moves'],
];

function unitOf(word: string): Unit | undefined {
	for (const [pattern, unit] of UNITS) {
		if (pattern.test(word)) {
			return unit;
		}
	}
	return undefined;
}

function periodsOf(text: string): Period[] | null {
	const normalized = text.toLowerCase().replace(/[’′]/g, "'").replace(/[″“”]/g, '"').replace(/,/g, ' ').trim();
	if (normalized.length === 0) {
		return null;
	}
	const parts = normalized.split('+').map((part) => part.trim());
	if (parts.some((part) => part.length === 0)) {
		return null;
	}
	const terms: Term[] = [];
	for (const part of parts) {
		const term = termOf(part);
		if (term === null) {
			return null;
		}
		terms.push(term);
	}

	// The increment is the last term when it is in seconds, or when a bare number follows a period
	// for the rest of the game: "15+10", "90/40 + 30 + 30". After a period for a number of moves a
	// bare number is the next period: "90/40 + 30".
	let increment = 0;
	let fromMove: number | null = null;
	const last = terms[terms.length - 1];
	const isIncrement =
		terms.length > 1 &&
		last.moves === null &&
		(last.unit === 'sec' || (last.unit === null && terms[terms.length - 2].moves === null));
	if (isIncrement) {
		increment = last.value;
		fromMove = last.fromMove;
		terms.pop();
	}
	if (terms.some((term) => term.fromMove !== null)) {
		return null;
	}

	const periods: Period[] = [];
	let move = 1;
	for (let at = 0; at < terms.length; at++) {
		const term = terms[at];
		if (term.unit === 'moves') {
			return null;
		}
		// Every period but the last is for a number of moves.
		if (at < terms.length - 1 && term.moves === null) {
			return null;
		}
		const seconds = term.unit === 'sec' ? term.value : term.value * 60;
		const applies = fromMove === null || move >= fromMove;
		periods.push({ moves: term.moves, seconds, increment: applies ? increment : 0 });
		move += term.moves ?? 0;
	}
	if (fromMove !== null && !periods.some((period) => period.increment > 0)) {
		return null;
	}
	if (fromMove !== null && fromMove !== 1 && !startsAPeriod(terms, fromMove)) {
		return null;
	}
	return valid(periods) ? periods : null;
}

// "+30 sec from move 41" can only be written in PGN when a period begins at move 41.
function startsAPeriod(terms: readonly Term[], fromMove: number): boolean {
	let move = 1;
	for (const term of terms) {
		if (move === fromMove) {
			return true;
		}
		move += term.moves ?? 0;
	}
	return false;
}

function termOf(part: string): Term | null {
	let rest = part;
	let fromMove: number | null = null;
	const from = /\s*from\s+move\s+(\d+)\s*$/.exec(rest);
	if (from) {
		fromMove = Number(from[1]);
		rest = rest.slice(0, from.index).trim();
	}

	const found = /^(\d+(?:\.\d+)?)\s*([a-z'"]+)?(?:\s*\/\s*(\d+)\s*([a-z]+)?)?$/.exec(rest);
	if (!found) {
		return null;
	}
	const value = Number(found[1]);
	const unit = found[2] === undefined ? null : unitOf(found[2]);
	if (unit === undefined) {
		return null;
	}
	let moves: number | null = null;
	if (found[3] !== undefined) {
		if (found[4] !== undefined && unitOf(found[4]) !== 'moves') {
			return null;
		}
		if (unit === 'moves' || unit === 'sec') {
			return null;
		}
		moves = Number(found[3]);
		// "40/90" is the American order, moves first: not guessed, kept as written.
		if (unit === null && found[4] === undefined && moves >= 60 && moves > value) {
			return null;
		}
	}
	if (!Number.isFinite(value) || (unit !== 'min' && unit !== null && !Number.isInteger(value))) {
		return null;
	}
	return { value, unit, moves, fromMove };
}

function valid(periods: readonly Period[]): boolean {
	return (
		periods.length > 0 &&
		periods.every(
			(period) =>
				Number.isInteger(period.seconds) &&
				period.seconds > 0 &&
				period.seconds <= MAX_SECONDS &&
				Number.isInteger(period.increment) &&
				period.increment >= 0 &&
				period.increment <= MAX_INCREMENT &&
				(period.moves === null || (Number.isInteger(period.moves) && period.moves > 0 && period.moves <= MAX_MOVES)),
		)
	);
}

function pgnOf(periods: readonly Period[]): string {
	if (periods.length === 1 && periods[0].moves === null) {
		return `${periods[0].seconds}+${periods[0].increment}`;
	}
	return periods
		.map(
			(period) =>
				`${period.moves === null ? '' : `${period.moves}/`}${period.seconds}${period.increment > 0 ? `+${period.increment}` : ''}`,
		)
		.join(':');
}

function pgnPeriods(pgn: string): Period[] | null {
	const periods: Period[] = [];
	for (const field of pgn.split(':')) {
		const found = /^(?:(\d+)\/)?(\d+)(?:\+(\d+))?$/.exec(field.trim());
		if (!found) {
			return null;
		}
		periods.push({
			moves: found[1] === undefined ? null : Number(found[1]),
			seconds: Number(found[2]),
			increment: found[3] === undefined ? 0 : Number(found[3]),
		});
	}
	return valid(periods) ? periods : null;
}

function nameOf(periods: readonly Period[]): string {
	const time = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`);
	const parts = periods.map(
		(period) => `${time(period.seconds)}${period.moves === null ? '' : ` / ${period.moves} moves`}`,
	);
	const base = parts.join(' + ');

	const increments = periods.map((period) => period.increment);
	if (increments.every((increment) => increment === 0)) {
		return base;
	}
	const first = increments.findIndex((increment) => increment > 0);
	const increment = increments[first];
	const same = increments.slice(first).every((one) => one === increment);
	if (!same) {
		return periods
			.map(
				(period) =>
					`${time(period.seconds)}${period.moves === null ? '' : ` / ${period.moves} moves`}${period.increment > 0 ? ` +${period.increment} sec` : ''}`,
			)
			.join(' + ');
	}
	const single = periods.length === 1;
	if (first === 0) {
		return single ? `${base} + ${increment} sec` : `${base}, +${increment} sec`;
	}
	const fromMove = 1 + periods.slice(0, first).reduce((sum, period) => sum + (period.moves ?? 0), 0);
	return `${base}, +${increment} sec from move ${fromMove}`;
}
