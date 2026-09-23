import { Injectable, computed, signal } from '@angular/core';

import {
	AgentError,
	AgentErrorCode,
	AgentHello,
	AgentSession,
	AgentState,
	BackupLocation,
	LocalDatabaseCard,
	LocalEngineCard,
	LocalIndexProgress,
} from './agent.models';
import { LocalBridge } from '../shell/desktop-bridge';

export const SEARCH_WINDOW_MS = 20_000;

@Injectable({ providedIn: 'root' })
export class AgentBridgeService {
	private readonly bridge: LocalBridge | null = window.premovedDesktop?.bridge ?? null;

	private readonly _state = signal<AgentState>(this.bridge ? 'connecting' : 'unlinked');
	private readonly _hello = signal<AgentHello | null>(null);
	private readonly _session = signal<AgentSession | null>(null);
	private readonly _databases = signal<readonly LocalDatabaseCard[]>([]);
	private readonly _engines = signal<readonly LocalEngineCard[]>([]);
	private readonly _error = signal<string | null>(null);
	private readonly _backup = signal<BackupLocation | null>(null);
	private readonly _catalogueLoaded = signal(false);
	private readonly _searchUntil = signal<number | null>(null);
	private readonly _indexing = signal<readonly LocalIndexProgress[]>([]);

	readonly state = this._state.asReadonly();
	readonly hello = this._hello.asReadonly();
	readonly session = this._session.asReadonly();
	readonly databases = this._databases.asReadonly();
	readonly engines = this._engines.asReadonly();
	readonly error = this._error.asReadonly();
	readonly backup = this._backup.asReadonly();
	readonly searchUntil = this._searchUntil.asReadonly();
	readonly catalogueLoaded = this._catalogueLoaded.asReadonly();

	readonly indexing = this._indexing.asReadonly();

	readonly connected = computed(() => this._state() === 'connected');

	// True when this is the desktop application rather than a page in a browser.
	readonly embedded = computed(() => this.bridge !== null);

	constructor() {
		void this.connect();

		this.on('db.progress', (data) => {
			const frame = data as LocalIndexProgress;
			this._indexing.update((all) => [...all.filter((one) => one.databaseId !== frame.databaseId), frame]);
		});

		this.on('db.changed', () => {
			this._indexing.set([]);
			void this.refresh();
		});
	}

	async connect(force = false): Promise<void> {
		if (!this.bridge) {
			return;
		}
		if (force) {
			this._catalogueLoaded.set(false);
		}
		this._state.set('connecting');
		try {
			this._hello.set(await this.request<AgentHello>('agent.hello'));
			this._session.set({
				protocol: 1,
				agent: 'PremovedPrep',
				username: '',
				keyId: 0,
				keyLabel: '',
				engineSessions: [],
			});
			this._state.set('connected');
			this._error.set(null);
			await this.refresh();
		} catch (error) {
			this._state.set('offline');
			this._error.set(error instanceof Error ? error.message : String(error));
		}
	}

	async refresh(): Promise<void> {
		if (!this.bridge) {
			return;
		}
		try {
			const [databases, engines, backup] = await Promise.all([
				this.request<LocalDatabaseCard[]>('db.list'),
				this.request<LocalEngineCard[]>('engine.list'),
				this.request<BackupLocation>('store.location'),
			]);
			this._databases.set(databases);
			this._engines.set(engines);
			this._backup.set(backup);
			this._catalogueLoaded.set(true);
		} catch (error) {
			this._error.set(error instanceof Error ? error.message : String(error));
		}
	}

	unpair(): void {
		this._databases.set([]);
		this._engines.set([]);
		this._catalogueLoaded.set(false);
	}

	async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		if (!this.bridge) {
			throw new AgentError('FAILED', 'This is the web version: there is no local half to ask');
		}
		const result = await this.bridge.request(method, params);
		if (!result.ok) {
			throw new AgentError(
				(result.code as AgentErrorCode | undefined) ?? 'FAILED',
				result.message ?? 'The local half refused',
			);
		}
		return result.value as T;
	}

	on(event: string, handler: (data: unknown) => void): () => void {
		if (!this.bridge) {
			return () => undefined;
		}
		return this.bridge.on(event, handler);
	}
}
