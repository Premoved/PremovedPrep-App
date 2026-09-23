import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { GameSortKey, GameSummary } from '../../../core/models/game-list.model';
import { OpeningExplorerService } from '../../../core/services/opening-explorer.service';
import { MoveTreeStore } from './move-tree.store';

export type GameListStatus = 'idle' | 'loading' | 'ready' | 'error';

const ASCENDING_FIRST: ReadonlySet<GameSortKey> = new Set<GameSortKey>(['WHITE_NAME', 'BLACK_NAME', 'EVENT']);

@Injectable()
export class GameListStore {
	private readonly api = inject(OpeningExplorerService);
	private readonly tree = inject(MoveTreeStore);

	private readonly _active = signal(false);
	private readonly _status = signal<GameListStatus>('idle');
	private readonly _rows = signal<readonly GameSummary[]>([]);
	private readonly _hasMore = signal(false);
	private readonly _error = signal<string | null>(null);

	private readonly _sort = signal<GameSortKey>('STRENGTH');
	private readonly _ascending = signal(false);
	private readonly _page = signal(0);

	readonly status = this._status.asReadonly();
	readonly error = this._error.asReadonly();
	readonly rows = this._rows.asReadonly();
	readonly hasMore = this._hasMore.asReadonly();
	readonly sort = this._sort.asReadonly();
	readonly ascending = this._ascending.asReadonly();

	readonly isEmpty = computed(() => this._status() === 'ready' && this._rows().length === 0);

	// Only the newest request may write the signals above.
	private requestId = 0;

	constructor() {
		// Reads _active first and returns: a closed tab does not track the position.
		effect(() => {
			if (!this._active()) {
				return;
			}
			const fen = this.tree.currentNode().fen;
			const sort = this._sort();
			const ascending = this._ascending();

			this.fetch(fen, sort, ascending, 0, false);
		});
	}

	setActive(active: boolean): void {
		this._active.set(active);
	}

	sortBy(key: GameSortKey): void {
		if (this._sort() === key) {
			this._ascending.update((value) => !value);
			return;
		}
		this._sort.set(key);
		this._ascending.set(ASCENDING_FIRST.has(key));
	}

	loadMore(): void {
		if (this._status() === 'loading' || !this._hasMore()) {
			return;
		}
		const next = this._page() + 1;
		this.fetch(this.tree.currentNode().fen, this._sort(), this._ascending(), next, true);
	}

	private fetch(fen: string, sort: GameSortKey, ascending: boolean, page: number, append: boolean): void {
		const id = ++this.requestId;
		this._page.set(page);
		this._status.set('loading');
		this._error.set(null);

		this.api.gamesAtPosition(fen, sort, ascending, page).subscribe({
			next: (result) => {
				if (id !== this.requestId) return;
				this._rows.update((rows) => (append ? [...rows, ...result.games] : [...result.games]));
				this._hasMore.set(result.hasMore);
				this._status.set('ready');
			},
			error: () => {
				if (id !== this.requestId) return;
				if (!append) {
					this._rows.set([]);
				}
				this._hasMore.set(false);
				this._error.set('The game database is not reachable.');
				this._status.set('error');
			},
		});
	}
}
