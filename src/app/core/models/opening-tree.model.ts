export interface TopGame {
	readonly id: number;
	readonly white: string;
	readonly whiteElo: number | null;
	readonly black: string;
	readonly blackElo: number | null;
	readonly result: string;
	readonly year: number | null;
	readonly event: string | null;
	readonly engine: boolean;
}

export interface OpeningTreeMove {
	readonly san: string;
	readonly uci: string;
	readonly games: number;
	readonly whiteWins: number;
	readonly draws: number;
	readonly blackWins: number;
	/** Percentages of the decided games, not of `games`. */
	readonly whitePct: number;
	readonly drawPct: number;
	readonly blackPct: number;
	readonly topGame: TopGame | null;
}

export interface OpeningTree {
	readonly fen: string;
	readonly games: number;
	readonly whiteWins: number;
	readonly draws: number;
	readonly blackWins: number;
	readonly whitePct: number;
	readonly drawPct: number;
	readonly blackPct: number;
	readonly moves: readonly OpeningTreeMove[];
}

export const EMPTY_OPENING_TREE: OpeningTree = {
	fen: '',
	games: 0,
	whiteWins: 0,
	draws: 0,
	blackWins: 0,
	whitePct: 0,
	drawPct: 0,
	blackPct: 0,
	moves: [],
};
