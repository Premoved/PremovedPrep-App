export type SearchSortKey =
	'DATE' | 'STRENGTH' | 'WHITE_NAME' | 'BLACK_NAME' | 'WHITE_ELO' | 'BLACK_ELO' | 'RESULT' | 'EVENT' | 'ECO' | 'MOVES';

export interface SearchResultGame {
	readonly id: number;
	readonly white: string;
	/** The FIDE id this side was linked to on import, and the `player` table's spelling of it. */
	readonly whiteFideId: number | null;
	readonly whiteFideName: string | null;
	readonly whiteElo: number | null;
	readonly black: string;
	readonly blackFideId: number | null;
	readonly blackFideName: string | null;
	readonly blackElo: number | null;
	readonly result: string;
	readonly date: string | null;
	readonly year: number | null;
	readonly event: string | null;
	readonly site: string | null;
	readonly round: string | null;
	readonly eco: string | null;
	readonly plyCount: number;
}

export interface SearchResultPage {
	readonly games: readonly SearchResultGame[];
	readonly hasMore: boolean;
	readonly page: number;
}

export interface PlayerProfile {
	readonly fideId: number;
	readonly name: string;
	readonly federation: string | null;
	readonly sex: string | null;
	readonly title: string | null;
	readonly wTitle: string | null;
	readonly oTitle: string | null;
	readonly foaTitle: string | null;
	readonly standardRating: number | null;
	readonly standardGames: number | null;
	readonly rapidRating: number | null;
	readonly rapidGames: number | null;
	readonly blitzRating: number | null;
	readonly blitzGames: number | null;
	readonly birthYear: number | null;
	readonly age: number | null;
	readonly active: boolean;
	readonly archiveGames: number;
	readonly peakArchiveElo: number | null;
	readonly archiveName: string;

	/** The four rank numbers the FIDE profile prints, computed by this backend. */
	readonly worldRankActive: number | null;
	readonly worldRankAll: number | null;
	readonly nationalRankActive: number | null;
	readonly nationalRankAll: number | null;
}

export function fideProfileUrl(fideId: number): string {
	return `https://ratings.fide.com/profile/${fideId}`;
}

export function fideFederationUrl(federation: string): string {
	return `https://ratings.fide.com/rankings.phtml?country=${encodeURIComponent(federation.trim().toUpperCase())}`;
}

export interface PlayerSuggestion {
	readonly fideId: number;
	readonly name: string;
	readonly federation: string | null;
	readonly title: string | null;
	readonly standardRating: number | null;
}

export type SearchColor = 'w' | 'b';

export interface AdvancedCriteria {
	readonly white: string;
	readonly black: string;
	readonly ignoreColours: boolean;
	readonly whiteEloMin: string;
	readonly whiteEloMax: string;
	readonly blackEloMin: string;
	readonly blackEloMax: string;
	readonly from: string;
	readonly to: string;
	readonly event: string;
	readonly eco: string;
	readonly results: readonly string[];
}

export const EMPTY_ADVANCED_CRITERIA: AdvancedCriteria = {
	white: '',
	black: '',
	ignoreColours: false,
	whiteEloMin: '',
	whiteEloMax: '',
	blackEloMin: '',
	blackEloMax: '',
	from: '',
	to: '',
	event: '',
	eco: '',
	results: [],
};

export function isCriteriaEmpty(criteria: AdvancedCriteria): boolean {
	return (
		!criteria.white.trim() &&
		!criteria.black.trim() &&
		!criteria.whiteEloMin.trim() &&
		!criteria.whiteEloMax.trim() &&
		!criteria.blackEloMin.trim() &&
		!criteria.blackEloMax.trim() &&
		!criteria.from.trim() &&
		!criteria.to.trim() &&
		!criteria.event.trim() &&
		!criteria.eco.trim() &&
		criteria.results.length === 0
	);
}

/** Which games the Player's Opening Tree is built from. Carried in the URL. */
export interface OpponentScope {
	readonly fideId: number;
	readonly color: SearchColor;
	readonly from: string | null;
	readonly to: string | null;
	readonly name: string | null;
}
