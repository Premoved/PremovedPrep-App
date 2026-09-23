import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AgentKeysService } from './agent-keys.service';
import { AgentKeySummary, NewAgentKey } from './agent.models';
import { AuthService } from '../services/auth.service';

@Injectable({ providedIn: 'root' })
export class AgentKeysStore {
	private readonly api = inject(AgentKeysService);
	private readonly auth = inject(AuthService);

	private readonly _keys = signal<readonly AgentKeySummary[]>([]);
	private readonly _loaded = signal(false);
	private readonly _error = signal<string | null>(null);

	readonly keys = this._keys.asReadonly();
	readonly error = this._error.asReadonly();

	readonly loaded = this._loaded.asReadonly();

	readonly live = computed(() => this._keys().filter((key) => !key.revokedAt));
	readonly revoked = computed(() => this._keys().filter((key) => key.revokedAt));

	readonly anyLinked = computed(() => this.live().length > 0);

	constructor() {
		effect(() => {
			if (this.auth.isLoggedIn()) {
				untracked(() => this.load());
			} else {
				this._keys.set([]);
				this._loaded.set(false);
				this._error.set(null);
			}
		});
	}

	load(): void {
		if (!this.auth.isLoggedIn()) return;

		this.api.list().subscribe({
			next: (list) => {
				this._keys.set(list);
				this._loaded.set(true);
				this._error.set(null);
			},
			error: (error: Error) => {
				this._error.set(error.message);
			},
		});
	}

	create(label: string): Observable<NewAgentKey> {
		return this.api.create(label).pipe(tap(() => this.load()));
	}

	revoke(id: number): Observable<void> {
		return this.api.revoke(id).pipe(tap(() => this.load()));
	}
}
