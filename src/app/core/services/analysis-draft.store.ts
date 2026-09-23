import { Injectable } from '@angular/core';

// Per-tab id in sessionStorage; a page with no application tab of its own falls back to this.
const TAB_KEY = 'premovedprep.board';

const DRAFTS_KEY = 'premovedprep.drafts';

const MAX_DRAFTS = 32;

const MAX_PGN_BYTES = 200_000;

export interface AnalysisDraft {
	readonly pgn: string;
	readonly line: readonly string[];
	readonly isStudy: boolean;
	readonly itemId: number | null;
	readonly savedAt: number;
}

type Drafts = Record<string, AnalysisDraft>;

@Injectable({ providedIn: 'root' })
export class AnalysisDraftStore {
	private id: string | null = null;

	read(owner: string): AnalysisDraft | null {
		const id = this.slot(owner);
		return id ? (this.all()[id] ?? null) : null;
	}

	/** Returns whether the draft was actually persisted; false means the work could still be lost. */
	write(owner: string, draft: AnalysisDraft): boolean {
		const id = this.slot(owner);
		if (!id || draft.pgn.length > MAX_PGN_BYTES) {
			return false;
		}
		return this.persist(this.trim({ ...this.all(), [id]: draft }));
	}

	clear(owner: string): void {
		const id = this.slot(owner);
		if (!id) {
			return;
		}
		const all = this.all();
		if (!(id in all)) {
			return;
		}
		delete all[id];
		this.persist(all);
	}

	private slot(owner: string): string | null {
		return owner.length > 0 ? owner : this.tabId();
	}

	private tabId(): string | null {
		if (this.id !== null) {
			return this.id;
		}
		try {
			const existing = sessionStorage.getItem(TAB_KEY);
			this.id = existing ?? crypto.randomUUID();
			if (existing === null) {
				sessionStorage.setItem(TAB_KEY, this.id);
			}
			return this.id;
		} catch {
			return null;
		}
	}

	private all(): Drafts {
		try {
			const raw = localStorage.getItem(DRAFTS_KEY);
			const parsed: unknown = raw ? JSON.parse(raw) : null;
			return typeof parsed === 'object' && parsed !== null ? (parsed as Drafts) : {};
		} catch {
			return {};
		}
	}

	private trim(all: Drafts): Drafts {
		const entries = Object.entries(all);
		if (entries.length <= MAX_DRAFTS) {
			return all;
		}
		entries.sort(([, a], [, b]) => b.savedAt - a.savedAt);
		return Object.fromEntries(entries.slice(0, MAX_DRAFTS));
	}

	private persist(all: Drafts): boolean {
		try {
			localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
			return true;
		} catch {
			// Quota, or private mode: losing the draft is preferable to losing the board.
			return false;
		}
	}
}
