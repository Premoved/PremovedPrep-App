import { Injectable, computed, signal } from '@angular/core';
import { CollectionKind } from '../models/collection.model';

export type ClipboardScope = 'COLLECTIONS' | 'ITEMS';

// A local-file collection on the clipboard: copied by folder.adopt, not a server transfer.
export interface LocalClipboardCollection {
	readonly id: string;
	readonly kind: CollectionKind;
}

export interface ClipboardContents {
	readonly scope: ClipboardScope;
	// True for Ctrl+C. False for Ctrl+X, where the originals are moved rather than duplicated.
	readonly copy: boolean;
	readonly ids: readonly number[];
	readonly label: string;
	// Set when the entries came from a local file: a file has no server ids, so PGN is what
	// both a cloud paste target and a local one can accept.
	readonly pgn?: string;
	readonly from?: { readonly collectionId: string; readonly entryIds: readonly string[] };
	// Set instead of `ids` when the clipboard holds whole local-file collections.
	readonly localCollections?: readonly LocalClipboardCollection[];
}

@Injectable({ providedIn: 'root' })
export class ClipboardStore {
	private readonly _contents = signal<ClipboardContents | null>(null);

	readonly contents = this._contents.asReadonly();
	readonly isEmpty = computed(() => this._contents() === null);

	put(scope: ClipboardScope, ids: readonly number[], copy: boolean, label: string): void {
		if (ids.length === 0) {
			return;
		}
		this._contents.set({ scope, copy, ids: [...ids], label });
	}

	putGames(pgn: string, copy: boolean, label: string, from: ClipboardContents['from']): void {
		if (pgn.trim().length === 0) {
			return;
		}
		this._contents.set({ scope: 'ITEMS', copy, ids: [], label, pgn, from });
	}

	// Copy only: a local file is not moved between folders the way a cloud row can be cut.
	putLocalCollections(collections: readonly LocalClipboardCollection[], label: string): void {
		if (collections.length === 0) {
			return;
		}
		this._contents.set({ scope: 'COLLECTIONS', copy: true, ids: [], label, localCollections: [...collections] });
	}

	take(scope: ClipboardScope): ClipboardContents | null {
		const contents = this._contents();
		return contents && contents.scope === scope ? contents : null;
	}

	consumed(): void {
		if (this._contents()?.copy === false) {
			this._contents.set(null);
		}
	}

	clear(): void {
		this._contents.set(null);
	}
}
