import { Injectable } from '@angular/core';

const KEY = 'premovedprep.gameSequence';
// A results page holds a few hundred games at most; more is never kept.
const KEPT = 1000;

export interface GameSequence {
	// 'cloud', or the id of the local database the games are in.
	readonly db: string;
	readonly ids: readonly string[];
}

/**
 * The games of the search a game was last opened from, in the order they were listed: on the board,
 * Previous and Next step through them as through a collection. Kept in localStorage, so a board opened
 * in another tab or window finds them too.
 */
@Injectable({ providedIn: 'root' })
export class GameSequenceStore {
	remember(db: string, ids: readonly (number | string)[]): void {
		try {
			localStorage.setItem(KEY, JSON.stringify({ db, ids: ids.slice(0, KEPT).map(String) }));
		} catch {
			// Storage full or refused: the board just has no Previous and Next for these games.
		}
	}

	read(): GameSequence | null {
		try {
			const value = JSON.parse(localStorage.getItem(KEY) ?? 'null');
			return value && typeof value.db === 'string' && Array.isArray(value.ids) ? (value as GameSequence) : null;
		} catch {
			return null;
		}
	}
}
