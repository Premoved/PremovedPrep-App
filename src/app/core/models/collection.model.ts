export type CollectionKind = 'LIBRARY' | 'REPERTOIRE';

export type RepertoireColor = 'w' | 'b';

export type ItemType = 'ANALYSIS' | 'STUDY' | 'GAME' | 'MAIN_LINE' | 'MODEL_GAME';

export type ItemShape = 'DOCUMENT' | 'GAME';

export type CollectionIcon = 'folder' | 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'king' | 'book' | 'star';

export const COLLECTION_ICONS: readonly CollectionIcon[] = [
	'folder',
	'book',
	'pawn',
	'knight',
	'bishop',
	'rook',
	'queen',
	'king',
];

export interface CollectionSummary {
	readonly id: number;
	readonly kind: CollectionKind;
	readonly color: RepertoireColor | null;
	readonly name: string;
	readonly icon: string;
	readonly sortOrder: number;
	readonly itemCount: number;
	readonly updatedAt: string;
}

/** A folder as it arrives: the shape of the shelf in the clear, the name sealed. */
export interface WireCollectionSummary extends Omit<CollectionSummary, 'name'> {
	readonly nameCipher: string;
}

export interface ItemRow {
	readonly id: number;
	readonly collectionId: number;
	readonly itemType: ItemType;
	readonly shape: ItemShape;
	readonly sortOrder: number;
	/** The sealed entry: the PGN, its title and its annotator. See item-payload.ts. */
	readonly payload: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ItemSummary {
	readonly id: number;
	readonly itemType: ItemType;
	readonly shape: ItemShape;
	readonly sortOrder: number;

	readonly title: string | null;
	readonly author: string | null;

	readonly white: string | null;
	readonly whiteElo: number | null;
	readonly black: string | null;
	readonly blackElo: number | null;
	/** PGN token, or null for a row that was never played. Not the same as '*'. */
	readonly result: string | null;
	readonly event: string | null;
	/** ISO date, or null when the source tag was partial. `year` is set either way. */
	readonly date: string | null;
	readonly year: number | null;

	readonly eco: string | null;
	readonly plyCount: number;
	readonly startFen: string | null;
	readonly updatedAt: string;
}

export interface ItemDetail extends ItemSummary {
	readonly collectionId: number;
	readonly pgn: string;
	readonly createdAt: string;
}

export type ItemSortKey =
	| 'MANUAL'
	| 'TYPE'
	| 'TYPE_STUDY_FIRST'
	| 'TYPE_GAME_FIRST'
	| 'WHITE'
	| 'BLACK'
	| 'WHITE_ELO'
	| 'BLACK_ELO'
	| 'RESULT'
	| 'ANNOTATOR'
	| 'ECO'
	| 'MOVES'
	| 'EVENT'
	| 'DATE'
	| 'UPDATED';

export interface ImportResult {
	readonly collectionId: number;
	readonly imported: number;
	readonly skipped: number;
	readonly skippedForSpace: number;
	readonly items: readonly ItemSummary[];
}

export const ITEM_TYPE_LABEL: Readonly<Record<ItemType, string>> = {
	ANALYSIS: 'analysis',
	STUDY: 'study',
	GAME: 'game',
	MAIN_LINE: 'main-line',
	MODEL_GAME: 'model-game',
};

export const ITEM_TYPES_BY_KIND: Readonly<Record<CollectionKind, readonly ItemType[]>> = {
	LIBRARY: ['ANALYSIS', 'STUDY', 'GAME'],
	REPERTOIRE: ['MAIN_LINE', 'MODEL_GAME'],
};

export const TYPE_SORT_STATES: Readonly<Partial<Record<ItemSortKey, readonly ItemType[]>>> = {
	TYPE: ['ANALYSIS', 'STUDY', 'GAME', 'MAIN_LINE', 'MODEL_GAME'],
	TYPE_STUDY_FIRST: ['STUDY', 'ANALYSIS', 'GAME', 'MAIN_LINE', 'MODEL_GAME'],
	TYPE_GAME_FIRST: ['GAME', 'ANALYSIS', 'STUDY', 'MAIN_LINE', 'MODEL_GAME'],
};

export const TYPE_SORT_KEYS: readonly ItemSortKey[] = ['TYPE', 'TYPE_STUDY_FIRST', 'TYPE_GAME_FIRST'];

export interface StorageUsage {
	readonly bytesUsed: number;
	readonly bytesQuota: number;
	/** Where writes actually stop, a little above the quota. */
	readonly bytesHardLimit: number;
	/** Max payload size per save request; absent on 507 responses — null means the server decides. */
	readonly bytesMaxRequest?: number;
	/** Per-collection usage in bytes; absent on older servers, which send no breakdown. */
	readonly perCollection?: Readonly<Record<string, number>>;
}
