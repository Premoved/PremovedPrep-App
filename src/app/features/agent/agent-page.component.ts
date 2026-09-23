import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AgentBridgeService } from '../../core/agent/agent-bridge.service';
import { AgentSelectionStore } from '../../core/agent/agent-selection.store';
import { BackupLocation, LocalDatabaseCard, LocalEngineCard } from '../../core/agent/agent.models';
import { ArchiveNameService } from '../../core/services/archive-name.service';
import { DatabaseIconComponent } from '../../shared/database-badge/database-icon.component';
import { EngineConcurrencyStore } from '../../core/engine/engine-concurrency.store';
import { EngineLoadStore } from '../../core/engine/engine-load.store';

@Component({
	selector: 'app-agent-page',
	standalone: true,
	imports: [DatabaseIconComponent],
	templateUrl: './agent-page.component.html',
	styleUrl: './agent-page.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentPageComponent {
	readonly bridge = inject(AgentBridgeService);
	readonly selection = inject(AgentSelectionStore);
	private readonly engineLoad = inject(EngineLoadStore);
	private readonly concurrency = inject(EngineConcurrencyStore);
	readonly archive = inject(ArchiveNameService);

	readonly running = this.engineLoad.running;

	readonly concurrent = this.concurrency.enabled;

	onConcurrent(event: Event): void {
		this.concurrency.set((event.target as HTMLInputElement).checked);
	}

	readonly busy = signal<string | null>(null);
	readonly failure = signal<string | null>(null);

	readonly location = computed<BackupLocation | null>(() => this.bridge.backup());
	readonly engines = computed(() => this.bridge.engines());
	readonly databases = computed(() => this.bridge.databases());

	// Live progress events first, then the shell's own record: a counting step can run a long time
	// between two reports, and a working index must not read as stopped in the gap.
	working(database: LocalDatabaseCard): string | null {
		const job = this.bridge.indexing().find((one) => one.databaseId === database.id) ?? database.progress ?? null;
		if (!job) {
			return database.running ? 'Indexing' : null;
		}
		const percent = job.total > 0 ? Math.min(100, Math.floor((job.done / job.total) * 100)) : null;
		if (job.stage === 'converting') {
			return percent === null ? 'Converting the index' : `Converting the index — ${percent}%`;
		}
		if (job.stage === 'counting') {
			return percent === null ? 'Counting positions' : `Counting positions — ${percent}%`;
		}
		return percent === null ? 'Indexing' : `Indexing — ${percent}%`;
	}

	addDatabase(): void {
		void this.run('db.choose', 'db.choose');
	}

	addGames(database: LocalDatabaseCard): void {
		void this.run('db.append', `db.append:${database.id}`, { databaseId: database.id });
	}

	rebuildDatabase(database: LocalDatabaseCard): void {
		void this.run('db.rebuild', `db.rebuild:${database.id}`, { databaseId: database.id });
	}

	// Offered here rather than done silently, unlike at start-up where an interrupted index resumes on its own.
	resumeDatabase(database: LocalDatabaseCard): void {
		void this.run('db.resume', `db.resume:${database.id}`, { databaseId: database.id });
	}

	removeDatabase(database: LocalDatabaseCard): void {
		if (this.selection.databaseId() === database.id) {
			this.selection.selectDatabase(null);
		}
		void this.run('db.remove', `db.remove:${database.id}`, { databaseId: database.id });
	}

	size(bytes: number): string {
		if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
		if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
		return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
	}

	chooseFolder(): void {
		void this.run('store.choose', 'store.choose');
	}

	addEngine(): void {
		void this.run('engine.choose', 'engine.choose');
	}

	removeEngine(engine: LocalEngineCard): void {
		if (this.selection.defaultEngineId() === engine.id) {
			this.selection.setDefaultEngine(null);
		}
		void this.run('engine.remove', `engine.remove:${engine.id}`, { engineId: engine.id });
	}

	isDefault(engine: LocalEngineCard): boolean {
		return this.selection.defaultEngine()?.id === engine.id;
	}

	setDefault(engine: LocalEngineCard): void {
		this.selection.setDefaultEngine(engine.id);
	}

	// Always refreshes after the call: choosing a folder creates directories, choosing an engine
	// interrogates a process, and neither response is the whole picture on its own.
	private async run(method: string, tag: string, params: Record<string, unknown> = {}): Promise<void> {
		if (this.busy() !== null) {
			return;
		}
		this.busy.set(tag);
		this.failure.set(null);
		try {
			await this.bridge.request(method, params);
			await this.bridge.refresh();
		} catch (error) {
			this.failure.set(error instanceof Error ? error.message : String(error));
		} finally {
			this.busy.set(null);
		}
	}
}
