import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { pieceCount } from '../../../core/chess/fen.util';
import { TablebaseResult } from '../../../core/models/tablebase.model';
import { TABLEBASE_MAX_PIECES, TablebaseService } from '../../../core/services/tablebase.service';
import { EngineStore } from './engine.store';

/** out-of-range is not an error: the position has too many pieces for the tables. */
export type TablebaseStatus = 'idle' | 'out-of-range' | 'loading' | 'ready' | 'empty' | 'error';

@Injectable()
export class TablebaseStore {
	private readonly api = inject(TablebaseService);
	private readonly engine = inject(EngineStore);

	private readonly _active = signal(false);
	private readonly _status = signal<TablebaseStatus>('idle');
	private readonly _result = signal<TablebaseResult | null>(null);

	readonly status = this._status.asReadonly();
	readonly result = this._result.asReadonly();
	readonly moves = computed(() => this._result()?.moves ?? []);

	readonly inRange = computed(() => pieceCount(this.engine.positionFen()) <= TABLEBASE_MAX_PIECES);

	private readonly cache = new Map<string, TablebaseResult | null>();
	private static readonly CACHE_LIMIT = 200;

	// Monotonic; only the newest request may write the signals above.
	private requestId = 0;

	constructor() {
		effect(() => {
			// Read the flag first and return early: a closed panel does not track the position.
			if (!this._active()) {
				return;
			}
			this.load(this.engine.positionFen());
		});
	}

	setActive(active: boolean): void {
		this._active.set(active);
	}

	private load(fen: string): void {
		if (pieceCount(fen) > TABLEBASE_MAX_PIECES) {
			this.requestId++;
			this._result.set(null);
			this._status.set('out-of-range');
			return;
		}

		if (this.cache.has(fen)) {
			this.requestId++;
			const cached = this.cache.get(fen) ?? null;
			this._result.set(cached);
			this._status.set(cached ? 'ready' : 'empty');
			return;
		}

		const id = ++this.requestId;
		this._status.set('loading');

		this.api.probe(fen).subscribe({
			next: (result) => {
				this.remember(fen, result);
				if (id !== this.requestId) return;
				this._result.set(result);
				this._status.set(result ? 'ready' : 'empty');
			},
			error: () => {
				if (id !== this.requestId) return;
				this._result.set(null);
				this._status.set('error');
			},
		});
	}

	private remember(fen: string, result: TablebaseResult | null): void {
		if (this.cache.size >= TablebaseStore.CACHE_LIMIT) {
			// Insertion order, so the first key is the oldest.
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
			}
		}
		this.cache.set(fen, result);
	}
}
