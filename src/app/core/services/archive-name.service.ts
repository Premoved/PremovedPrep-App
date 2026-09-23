import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { AgentSelectionStore } from '../agent/agent-selection.store';
import { AgentBridgeService } from '../agent/agent-bridge.service';

export interface DatabaseChoice {
	// null identifies the server archive; a local database has a real card id.
	readonly id: number | null;
	readonly name: string;
	readonly cloud: boolean;
	readonly path: string | null;
	readonly ready: boolean;
}

@Injectable({ providedIn: 'root' })
export class ArchiveNameService {
	private readonly http = inject(HttpClient);
	private readonly selection = inject(AgentSelectionStore);
	private readonly bridge = inject(AgentBridgeService);

	// Used before the server replies, and if it never does.
	private static readonly FALLBACK = 'Database';

	private readonly _shipped = signal<string | null>(null);

	readonly cloudName = computed(() => this._shipped() ?? ArchiveNameService.FALLBACK);

	readonly cloud = computed<DatabaseChoice>(() => ({
		id: null,
		name: this.cloudName(),
		cloud: true,
		path: null,
		ready: true,
	}));

	readonly local = computed<readonly DatabaseChoice[]>(() =>
		this.bridge.databases().map((card) => ({
			id: card.id,
			name: card.name,
			cloud: false,
			path: card.path,
			ready: card.ready,
		})),
	);

	readonly choices = computed<readonly DatabaseChoice[]>(() => [this.cloud(), ...this.local()]);

	readonly inUse = computed<DatabaseChoice>(() => {
		const chosen = this.selection.database();
		if (!chosen) {
			return this.cloud();
		}
		return this.local().find((choice) => choice.id === chosen.id) ?? this.cloud();
	});

	readonly label = computed(() => this.inUse().name);

	constructor() {
		this.http.get<{ name: string }>(`${environment.apiBaseUrl}/archive`).subscribe({
			next: (archive) => this._shipped.set(archive.name?.trim() || null),
			error: () => this._shipped.set(null),
		});
	}
}
