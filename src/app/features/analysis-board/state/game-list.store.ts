import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { GameSortKey, GameSummary } from '../../../core/models/game-list.model';
import { OpeningExplorerService } from '../../../core/services/opening-explorer.service';
import { AgentSelectionStore } from '../../../core/agent/agent-selection.store';
import { queryChannel } from '../../../core/agent/agent-bridge.service';
import { AgentError } from '../../../core/agent/agent.models';
import { MoveTreeStore } from './move-tree.store';

export type GameListStatus = 'idle' | 'loading' | 'ready' | 'error';

// Stepping through moves asks only for the position it stops on.
const POSITION_SETTLE_MS = 150;

const ASCENDING_FIRST: ReadonlySet<GameSortKey> = new Set<GameSortKey>(['WHITE_NAME', 'BLACK_NAME', 'EVENT']);

@Injectable()
export class GameListStore {
	private readonly api = inject(OpeningExplorerService);
	private readonly tree = inject(MoveTreeStore);
	private readonly selection = inject(AgentSelectionStore);

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

	readonly noDatabase = computed(() => this.selection.noDatabase());

	// Only the newest request may write the signals above.
	private requestId = 0;

	private readonly channel = queryChannel('game-list');
	private settle: ReturnType<typeof setTimeout> | null = null;
	private lastFen: string | null = null;

	constructor() {
		// Reads _active first and returns: a closed tab does not track the position.
		effect(() => {
			if (!this._active()) {
				return;
			}
			// Nothing to read from: the panel says so instead of showing a failure.
			if (this.selection.noDatabase()) {
				this.cancelSettle();
				this.requestId++;
				this._rows.set([]);
				this._hasMore.set(false);
				this._error.set(null);
				this._status.set('idle');
				return;
			}

			// Read here, not only inside fetch(): a settled fetch runs outside the effect and would not track it.
			this.selection.database();

			const fen = this.tree.currentNode().fen;
			const sort = this._sort();
			const ascending = this._ascending();

			const moved = fen !== this.lastFen;
			this.lastFen = fen;
			this.cancelSettle();
			if (!moved) {
				this.fetch(fen, sort, ascending, 0, false);
				return;
			}
			this.requestId++;
			this._status.set('loading');
			this.settle = setTimeout(() => {
				this.settle = null;
				this.fetch(fen, sort, ascending, 0, false);
			}, POSITION_SETTLE_MS);
		});
	}

	private cancelSettle(): void {
		if (this.settle !== null) {
			clearTimeout(this.settle);
			this.settle = null;
		}
	}

	setActive(active: boolean): void {
		if (!active) {
			this.cancelSettle();
			this.lastFen = null;
		}
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
		if (this._status() === 'loading' || !this._hasMore() || this.selection.noDatabase()) {
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

		this.api.gamesAtPosition(fen, sort, ascending, page, this.channel).subscribe({
			next: (result) => {
				if (id !== this.requestId) return;
				this._rows.update((rows) => (append ? [...rows, ...result.games] : [...result.games]));
				this._hasMore.set(result.hasMore);
				this._status.set('ready');
			},
			error: (failure: unknown) => {
				if (id !== this.requestId) return;
				if (!append) {
					this._rows.set([]);
				}
				this._hasMore.set(false);
				// A local database explains itself (too broad, still preparing); the server only fails to answer.
				this._error.set(failure instanceof AgentError ? failure.message : 'The game database is not reachable.');
				this._status.set('error');
			},
		});
	}
}
