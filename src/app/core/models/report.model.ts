/** Only shape here that crosses the wire; movesSan is pre-normalised (no comments/variations). */
export interface ArchiveGame {
	readonly id: number;
	readonly white: string | null;
	readonly whiteElo: number | null;
	readonly black: string | null;
	readonly blackElo: number | null;
	readonly result: string | null;
	readonly year: number | null;
	readonly event: string | null;
	readonly movesSan: string | null;
}

/** What GET /api/report/opponent-games answers. */
export interface OpponentGames {
	readonly fideId: number;
	readonly opponentColor: 'w' | 'b';
	readonly gamesRead: number;
	/** True when the archive had more than the cap and the rest were not read. */
	readonly truncated: boolean;
	readonly games: readonly ArchiveGame[];
}

export type ReportPointKind = 'OVERLAP' | 'DEVIATION';

export interface ReportGame {
	readonly id: number;
	readonly white: string | null;
	readonly whiteElo: number | null;
	readonly black: string | null;
	readonly blackElo: number | null;
	readonly result: string | null;
	readonly year: number | null;
	readonly event: string | null;
	readonly ply: number;
}

export interface ReportMove {
	readonly uci: string;
	readonly san: string;
	/** How many of the opponent's games played it. `sample` is capped; this is the real count. */
	readonly games: number;
	readonly sample: readonly ReportGame[];
}

export interface ReportBookFile {
	readonly itemId: number;
	readonly title: string;
}

export interface ReportPoint {
	readonly kind: ReportPointKind;
	readonly index: number;
	readonly line: readonly string[];
	readonly moves: readonly ReportMove[];
	readonly book: readonly ReportBookFile[];
}

export interface ReportNode {
	readonly uci: string | null;
	readonly san: string | null;
	readonly games: number;
	readonly point: ReportPoint | null;
	readonly children: readonly ReportNode[];
}

export interface AdvancedReport {
	readonly fideId: number;
	readonly opponentColor: 'w' | 'b';
	readonly repertoireColor: 'w' | 'b';
	readonly repertoireFiles: number;
	readonly gamesRead: number;
	readonly truncated: boolean;
	readonly overlaps: number;
	readonly deviations: number;
	readonly root: ReportNode;
}
