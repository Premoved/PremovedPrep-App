export type GameSortKey =
	'STRENGTH' | 'WHITE_NAME' | 'WHITE_ELO' | 'RESULT' | 'BLACK_NAME' | 'BLACK_ELO' | 'DATE' | 'EVENT';

export interface GameSummary {
	readonly id: number;
	readonly white: string;
	readonly whiteElo: number | null;
	readonly black: string;
	readonly blackElo: number | null;
	readonly result: string;
	readonly date: string | null;
	readonly year: number | null;
	readonly event: string | null;
	readonly eco: string | null;
	/** Half-move at which this game reached the requested position. 0 means it started there. */
	readonly ply: number;
}

export interface GamePage {
	readonly fen: string;
	readonly games: readonly GameSummary[];
	/** Whether another page exists. Not a total count. */
	readonly hasMore: boolean;
}

export interface GameDetail {
	readonly id: number;
	readonly white: string;
	readonly whiteElo: number | null;
	readonly black: string;
	readonly blackElo: number | null;
	readonly result: string;
	readonly date: string | null;
	readonly year: number | null;
	readonly event: string | null;
	readonly site: string | null;
	readonly round: string | null;
	readonly eco: string | null;
	readonly pgn: string;
}
