export type CollectionKind = 'LIBRARY' | 'REPERTOIRE';

export type RepertoireColor = 'w' | 'b';

// What an entry is for, never what it holds: every type carries the same game data (the PGN tags).
// The type only switches behaviour: a STUDY hides its solutions, a MAIN_LINE is a repertoire's trunk.
export type ItemType = 'STUDY' | 'GAME' | 'MAIN_LINE' | 'MODEL_GAME';

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
	readonly sortOrder: number;
	/** The sealed entry: the PGN. See item-payload.ts. */
	readonly payload: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ItemSummary {
	readonly id: number;
	readonly itemType: ItemType;
	readonly sortOrder: number;

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
	readonly annotator: string | null;

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
	STUDY: 'study',
	GAME: 'game',
	MAIN_LINE: 'main-line',
	MODEL_GAME: 'model-game',
};

/** The other type of the same shelf: what "Change to" in a collection turns a type into. */
export function retagTargetFor(itemType: ItemType): ItemType {
	switch (itemType) {
		case 'MAIN_LINE':
			return 'MODEL_GAME';
		case 'MODEL_GAME':
			return 'MAIN_LINE';
		case 'STUDY':
			return 'GAME';
		case 'GAME':
			return 'STUDY';
	}
}

export const ITEM_TYPES_BY_KIND: Readonly<Record<CollectionKind, readonly ItemType[]>> = {
	LIBRARY: ['STUDY', 'GAME'],
	REPERTOIRE: ['MAIN_LINE', 'MODEL_GAME'],
};

export const TYPE_SORT_STATES: Readonly<Partial<Record<ItemSortKey, readonly ItemType[]>>> = {
	TYPE: ['STUDY', 'GAME', 'MAIN_LINE', 'MODEL_GAME'],
	TYPE_STUDY_FIRST: ['STUDY', 'GAME', 'MAIN_LINE', 'MODEL_GAME'],
	TYPE_GAME_FIRST: ['GAME', 'STUDY', 'MAIN_LINE', 'MODEL_GAME'],
};

// ANALYSIS was merged into GAME. The server retags its rows; this covers anything older than that,
// such as a file on disk or a row read before the server was updated.
export function itemTypeOf(raw: string): ItemType {
	return raw === 'ANALYSIS' ? 'GAME' : (raw as ItemType);
}

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
