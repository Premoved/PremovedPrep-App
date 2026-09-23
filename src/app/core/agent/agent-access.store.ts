import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { AgentAccess } from './agent.models';
import { AuthService } from '../services/auth.service';

@Injectable({ providedIn: 'root' })
export class AgentAccessStore {
	private readonly http = inject(HttpClient);
	private readonly auth = inject(AuthService);

	private readonly _access = signal<AgentAccess | null>(null);
	private readonly _loaded = signal(false);

	readonly access = this._access.asReadonly();

	readonly loaded = this._loaded.asReadonly();

	// Optimistic default: assumes access is allowed until the server answers.
	readonly allowed = computed(() => this._access()?.allowed ?? true);

	readonly stage = computed(() => this._access()?.stage ?? null);

	readonly preview = computed(() => this._access()?.reason === 'PREVIEW');

	readonly needsPlan = computed(() => this._access()?.reason === 'PLAN');

	readonly insider = computed(() => this._access()?.insider === true);

	constructor() {
		effect(() => {
			if (this.auth.isLoggedIn()) {
				untracked(() => this.load());
			} else {
				this._access.set(null);
				this._loaded.set(false);
			}
		});
	}

	load(): void {
		if (!this.auth.isLoggedIn()) return;

		this.http.get<AgentAccess>(`${environment.apiBaseUrl}/agent/access`).subscribe({
			next: (access) => {
				this._access.set(access);
				this._loaded.set(true);
			},
			error: () => {
				this._access.set(null);
				this._loaded.set(false);
			},
		});
	}
}
