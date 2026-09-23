/** Free-form: an unknown category is treated as a draw. */
export type TablebaseCategory = string;

export interface TablebaseMove {
	readonly uci: string;
	readonly san: string;
	readonly category: TablebaseCategory;
	/** Plies to the next capture or pawn move, which is what the fifty-move counter watches. */
	readonly dtz: number | null;
	/** Plies to mate, where the tables carry it. */
	readonly dtm: number | null;
}

export interface TablebaseResult {
	readonly category: TablebaseCategory;
	readonly dtz: number | null;
	readonly dtm: number | null;
	readonly moves: readonly TablebaseMove[];
}

export type TablebaseOutcome = 'win' | 'draw' | 'loss';

const WINNING = new Set(['win', 'cursed-win', 'maybe-win', 'syzygy-win']);
const LOSING = new Set(['loss', 'blessed-loss', 'maybe-loss', 'syzygy-loss']);

export function outcomeOf(category: TablebaseCategory): TablebaseOutcome {
	if (WINNING.has(category)) return 'win';
	if (LOSING.has(category)) return 'loss';
	return 'draw';
}

export function categoryLabel(category: TablebaseCategory): string {
	switch (category) {
		case 'win':
			return 'Win';
		case 'loss':
			return 'Loss';
		case 'draw':
			return 'Draw';
		case 'cursed-win':
			return 'Cursed win';
		case 'blessed-loss':
			return 'Blessed loss';
		case 'maybe-win':
			return 'Probably winning';
		case 'maybe-loss':
			return 'Probably losing';
		case 'unknown':
			return 'Unknown';
		default:
			return category;
	}
}
