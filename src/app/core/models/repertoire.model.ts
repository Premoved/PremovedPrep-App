export interface RepertoireGame {
	readonly itemId: number;
	readonly white: string | null;
	readonly whiteElo: number | null;
	readonly black: string | null;
	readonly blackElo: number | null;
	readonly result: string | null;
	readonly event: string | null;
	readonly date: string | null;
	readonly year: number | null;
	readonly eco: string | null;
	readonly plyCount: number;
	readonly ply: number;
}

export interface RepertoireBranch {
	readonly uci: string;
	readonly games: readonly RepertoireGame[];
	readonly children: readonly RepertoireBranch[];
}

export interface RepertoireAttachment {
	readonly path: readonly string[];
	readonly games: readonly RepertoireGame[];
	readonly branches: readonly RepertoireBranch[];
}

export interface RepertoireTree {
	readonly itemId: number;
	readonly collectionId: number;
	// Set when built from a local file: itemId is then the game's position within it, not a server id.
	readonly localCollectionId?: string;
	readonly color: 'w' | 'b' | null;
	readonly modelGames: number;
	// Lower than modelGames when a game shares no position with the trunk.
	readonly linked: number;
	readonly attachments: readonly RepertoireAttachment[];
}
