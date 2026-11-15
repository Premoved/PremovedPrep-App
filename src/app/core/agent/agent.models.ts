import { CollectionKind, ItemType, RepertoireColor } from '../models/collection.model';

export type AgentState =
	'idle' | 'unlinked' | 'searching' | 'offline' | 'unpaired' | 'connecting' | 'connected' | 'refused';

export interface AgentHello {
	readonly agent: string;
	readonly version: string;
	readonly protocol: number;
	readonly paired: boolean;
	readonly bridge: string;
}

export interface AgentSession {
	readonly protocol: number;
	readonly agent: string;
	readonly username: string;
	readonly keyId: number;
	readonly keyLabel: string;
	readonly engineSessions: readonly EngineSessionHandle[];
}

export interface EngineSessionHandle {
	readonly sessionId: string;
	readonly engineId: number;
	readonly engineName: string;
}

export interface LocalDatabaseCard {
	readonly id: number;
	readonly name: string;
	readonly path: string;
	readonly games: number;
	readonly positions: number;
	readonly maxPly: number;
	/** The database's own file; its games are kept in it, so the PGNs it was made from are not needed. */
	readonly location: string;
	/** Size on disk of that file. */
	readonly bytes: number;
	/** Size of the PGNs it was read from. */
	readonly pgnBytes?: number;
	readonly ready: boolean;
	readonly stale: boolean;
	readonly paused: boolean;
	// Why the last run ended without finishing, one readable line; null when it finished or is running.
	readonly failure?: string | null;
	readonly updatedAt: string;
	readonly running?: boolean;
	// Last progress reported for this job; kept in the bridge so a page opened later still sees it.
	readonly progress?: Omit<LocalIndexProgress, 'databaseId'> | null;
}

/** The positions of a search database, built from its games: Opening tree and Games list read them. */
export interface LocalPositionsCard {
	readonly id: number;
	/** The search database they were built from, whose name they carry. */
	readonly databaseId: number;
	readonly name: string;
	readonly location: string;
	/** Kept in the search database's own file (indexed before the two were apart): no size of its own. */
	readonly combined: boolean;
	readonly bytes: number | null;
	readonly positions: number;
	/** Games added to the search database since the positions were last counted. */
	readonly newGames: number;
	/** Games of the search database were read again: Update counts every game from the start. */
	readonly outdated: boolean;
	readonly ready: boolean;
	readonly paused: boolean;
	readonly failure: string | null;
	readonly running: boolean;
	readonly progress: Omit<LocalIndexProgress, 'databaseId'> | null;
	readonly updatedAt: string;
}

/** A search database positions can be built from, with the room they would take. */
export interface LocalPositionsCandidate {
	readonly databaseId: number;
	readonly name: string;
	readonly needed: number;
	/** False while it is still being indexed or copied. */
	readonly available: boolean;
}

export interface LocalPositionsCandidates {
	readonly free: number | null;
	readonly databases: readonly LocalPositionsCandidate[];
}

export interface LocalIndexFailure {
	readonly databaseId: number;
	// Null only for an event from a shell older than the page.
	readonly name: string | null;
	readonly message: string;
}

export interface LocalIndexProgress {
	// The search database's id, or the positions' id while they are counted.
	readonly databaseId: number;
	// reading: a search database reads its PGNs. preparing: its sort indexes and name list. counting: positions
	// being counted. compacting: positions taken out of a search database's file. exporting, importing: the
	// file Export or Import copies. converting: no longer sent, kept for a page older than the shell.
	readonly stage: 'reading' | 'converting' | 'counting' | 'preparing' | 'compacting' | 'exporting' | 'importing';
	readonly done: number;
	readonly total: number;
	// Estimated seconds left for the whole run as of `at` (ms since epoch); null until there is enough to go on.
	readonly secondsLeft?: number | null;
	readonly at?: number;
	// Set while the disk has little more room than the run still needs.
	readonly space?: { readonly needed: number; readonly free: number } | null;
}

export interface LocalEngineCard {
	readonly id: number;
	readonly name: string;
	readonly reportedName: string | null;
	readonly author: string | null;
	readonly threads: boolean;
	readonly maxThreads: number | null;
	readonly maxHashMb: number | null;
	readonly multiPv: boolean;
	readonly bundled: boolean;
}

export interface BackupLocation {
	readonly parent: string;
	readonly root: string;
	readonly library: string;
	readonly white: string;
	readonly black: string;
	readonly exists: boolean;
}

export interface LocalFolderCollection {
	readonly id: string;
	readonly kind: 'LIBRARY' | 'REPERTOIRE';
	readonly color: 'w' | 'b' | null;
	readonly name: string;
	readonly relativePath: string;
	readonly itemCount: number;
	readonly truncated: boolean;
	readonly bytes: number;
	readonly updatedAt: string;
	readonly cloudId: number | null;
	readonly icon: string;
	readonly syncedDigest?: string | null;
	/** Place in the shelf's custom order; null until the user has dragged the shelf into one. */
	readonly sortOrder?: number | null;
}

export interface LocalFolderEntry {
	readonly id: string;
	readonly itemType: string;
	readonly white: string | null;
	readonly whiteElo: number | null;
	readonly black: string | null;
	readonly blackElo: number | null;
	readonly result: string | null;
	readonly event: string | null;
	readonly date: string | null;
	readonly year: number | null;
	readonly annotator: string | null;
	readonly eco: string | null;
	readonly plyCount: number;
	readonly startFen: string | null;
	readonly updatedAt: string;
}

export interface LocalFolderEntryDetail extends LocalFolderEntry {
	readonly collectionId: string;
	readonly collectionName: string;
	readonly kind: CollectionKind;
	readonly color: RepertoireColor | null;
	readonly pgn: string;
}

export interface LocalOpenEntry {
	readonly id: string;
	readonly kind: CollectionKind;
	readonly color: RepertoireColor | null;
	readonly itemType: ItemType;
}

// SUPERSEDED: a newer request on the same channel replaced it. TIMEOUT: stopped after the shell's time limit.
export type AgentErrorCode =
	| 'UNAUTHORIZED'
	| 'UNKNOWN_METHOD'
	| 'BAD_REQUEST'
	| 'NOT_FOUND'
	| 'FAILED'
	| 'SUPERSEDED'
	| 'TIMEOUT'
	// An imported database made by a newer version of the application.
	| 'NEWER_VERSION';

export class AgentError extends Error {
	constructor(
		readonly code: AgentErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'AgentError';
	}
}

export interface AgentKeySummary {
	readonly id: number;
	readonly label: string;
	readonly prefix: string;
	readonly createdAt: string;
	readonly lastSeenAt: string | null;
	readonly revokedAt: string | null;
}

export interface NewAgentKey {
	readonly id: number;
	readonly label: string;
	readonly key: string;
	readonly prefix: string;
}
