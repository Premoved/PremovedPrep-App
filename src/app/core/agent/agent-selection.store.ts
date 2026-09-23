import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AgentBridgeService } from './agent-bridge.service';
import { LocalDatabaseCard, LocalEngineCard } from './agent.models';

const DATABASE_KEY = 'premovedprep.agent.database';
const ENGINE_KEY = 'premovedprep.agent.engine';

@Injectable({ providedIn: 'root' })
export class AgentSelectionStore {
	private readonly bridge = inject(AgentBridgeService);

	private readonly _databaseId = signal<number | null>(read(DATABASE_KEY));
	private readonly _defaultEngineId = signal<number | null>(read(ENGINE_KEY));

	readonly databaseId = this._databaseId.asReadonly();

	readonly defaultEngineId = this._defaultEngineId.asReadonly();

	readonly database = computed<LocalDatabaseCard | null>(() => {
		if (!this.bridge.connected()) {
			return null;
		}
		const id = this._databaseId();
		return this.bridge.databases().find((card) => card.id === id) ?? null;
	});

	readonly defaultEngine = computed<LocalEngineCard | null>(() => {
		if (!this.bridge.connected()) {
			return null;
		}
		const engines = this.bridge.engines();
		const id = this._defaultEngineId();
		const chosen = id === null ? null : engines.find((card) => card.id === id);
		// Nothing chosen, or it's gone: fall back to the bundled engine, then to whatever else there is.
		return chosen ?? engines.find((card) => card.bundled) ?? engines[0] ?? null;
	});

	readonly usingLocalDatabase = computed(() => this.database() !== null);

	constructor() {
		effect(() => this.reconcile());

		// Keeps this tab's selection in step when another tab changes it.
		window.addEventListener('storage', (event) => {
			if (event.key === null || event.key === DATABASE_KEY || event.key === ENGINE_KEY) {
				this.adoptExternalChange();
			}
		});
	}

	selectDatabase(id: number | null): void {
		this._databaseId.set(id);
		write(DATABASE_KEY, id);
	}

	setDefaultEngine(id: number | null): void {
		this._defaultEngineId.set(id);
		write(ENGINE_KEY, id);
	}

	private adoptExternalChange(): void {
		this._databaseId.set(read(DATABASE_KEY));
		this._defaultEngineId.set(read(ENGINE_KEY));
	}

	private reconcile(): void {
		if (!this.bridge.connected() || !this.bridge.catalogueLoaded()) {
			return;
		}

		const databaseId = this._databaseId();
		if (databaseId !== null && !this.bridge.databases().some((card) => card.id === databaseId)) {
			this.selectDatabase(null);
		}

		const engineId = this._defaultEngineId();
		if (engineId !== null && !this.bridge.engines().some((card) => card.id === engineId)) {
			this.setDefaultEngine(null);
		}
	}
}

function read(key: string): number | null {
	const raw = localStorage.getItem(key);
	if (raw === null) {
		return null;
	}
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

function write(key: string, value: number | null): void {
	if (value === null) {
		localStorage.removeItem(key);
	} else {
		localStorage.setItem(key, String(value));
	}
}
