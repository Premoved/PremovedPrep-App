import { Injectable, signal } from '@angular/core';

export interface OpeningTreeTarget {
	/** UCI moves from the starting position. */
	readonly line: readonly string[];
}

// Provided only where a Player's Opening Tree sits next to the report (the opponent search). The
// report's cards offer the link only when it is there; the analysis board has no tree to move to.
@Injectable()
export class OpeningTreeLink {
	private readonly _target = signal<OpeningTreeTarget | null>(null);

	/** A new object on every request, so asking for the same position twice still moves the board. */
	readonly target = this._target.asReadonly();

	open(line: readonly string[]): void {
		this._target.set({ line: [...line] });
	}
}
