import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';

import { AgentBridgeService } from '../../core/agent/agent-bridge.service';
import { AgentSelectionStore, CLOUD_DATABASE_SIGN_IN } from '../../core/agent/agent-selection.store';
import { NotificationService } from '../../core/services/notification.service';
import { AuthService } from '../../core/services/auth.service';
import {
	AgentError,
	BackupLocation,
	LocalDatabaseCard,
	LocalEngineCard,
	LocalIndexProgress,
	LocalPositionsCandidate,
	LocalPositionsCandidates,
	LocalPositionsCard,
} from '../../core/agent/agent.models';
import { ConfirmService } from '../../core/services/confirm.service';
import { ArchiveNameService } from '../../core/services/archive-name.service';
import { DatabaseIconComponent } from '../../shared/database-badge/database-icon.component';
import { EngineConcurrencyStore } from '../../core/engine/engine-concurrency.store';
import { EngineLoadStore } from '../../core/engine/engine-load.store';
import { UpdateService } from '../../core/shell/update.service';

const TICK_MS = 10_000;

type ResourceTab = 'location' | 'engines' | 'search' | 'positions';

const TAB_KEY = 'premovedprep.agent.tab';

const TABS: readonly { readonly id: ResourceTab; readonly label: string }[] = [
	{ id: 'location', label: 'Location' },
	{ id: 'engines', label: 'Engines' },
	{ id: 'search', label: 'Search databases' },
	{ id: 'positions', label: 'Position databases' },
];

// The tab last open, so coming back to the page lands where you were.
function savedTab(): ResourceTab {
	try {
		const saved = localStorage.getItem(TAB_KEY);
		return TABS.some((one) => one.id === saved) ? (saved as ResourceTab) : 'location';
	} catch {
		return 'location';
	}
}

// Rounded to what an estimate can tell: whole minutes, five-minute steps past an hour. Never below a
// minute: the last steps report rarely, and a run that outlasts its estimate still has a little left.
function timeLeftLabel(seconds: number): string {
	const minutes = Math.max(1, Math.round(seconds / 60));
	if (minutes < 60) {
		return `~${minutes} min left`;
	}
	const rounded = Math.round(minutes / 5) * 5;
	const hours = Math.floor(rounded / 60);
	const rest = rounded % 60;
	return rest === 0 ? `~${hours} h left` : `~${hours} h ${rest} min left`;
}

@Component({
	selector: 'app-agent-page',
	standalone: true,
	imports: [DatabaseIconComponent, DecimalPipe],
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
	private readonly notify = inject(NotificationService);
	private readonly auth = inject(AuthService);
	private readonly updates = inject(UpdateService);
	private readonly confirm = inject(ConfirmService);

	// Counts the time left down between two reports, which can be minutes apart while positions are counted.
	private readonly now = signal(Date.now());

	constructor() {
		const ticking = setInterval(() => this.now.set(Date.now()), TICK_MS);
		inject(DestroyRef).onDestroy(() => clearInterval(ticking));
	}

	// Listed signed out too, so it can be found; using it needs an account.
	useCloudDatabase(): void {
		if (!this.auth.isLoggedIn()) {
			this.notify.info(CLOUD_DATABASE_SIGN_IN);
			return;
		}
		this.selection.selectDatabase(null);
	}

	useCloudPositions(): void {
		if (!this.auth.isLoggedIn()) {
			this.notify.info(CLOUD_DATABASE_SIGN_IN);
			return;
		}
		this.selection.selectPositions(null);
	}

	readonly running = this.engineLoad.running;

	readonly concurrent = this.concurrency.enabled;

	onConcurrent(event: Event): void {
		this.concurrency.set((event.target as HTMLInputElement).checked);
	}

	readonly busy = signal<string | null>(null);
	// Shown in the open tab, above the buttons that led to it.
	readonly failure = signal<string | null>(null);

	readonly tabs = TABS;
	readonly tab = signal<ResourceTab>(savedTab());

	selectTab(tab: ResourceTab): void {
		this.tab.set(tab);
		this.failure.set(null);
		try {
			localStorage.setItem(TAB_KEY, tab);
		} catch {
			// Remembering the tab is a convenience.
		}
	}

	readonly location = computed<BackupLocation | null>(() => this.bridge.backup());
	readonly engines = computed(() => this.bridge.engines());
	readonly databases = computed(() => this.bridge.databases());
	readonly positionDatabases = computed(() => this.bridge.positionDatabases());

	// The window Add a database opens under Position databases: the search databases to build from.
	readonly picker = signal<LocalPositionsCandidates | null>(null);

	// A failed run on a database still listed shows on its row; one that indexed nothing is gone from the list.
	readonly droppedFailure = computed(() => {
		const failure = this.bridge.indexFailure();
		return failure && !this.databases().some((database) => database.id === failure.databaseId) ? failure : null;
	});

	// Live progress events first, then the shell's own record: a counting step can run a long time
	// between two reports, and a working index must not read as stopped in the gap.
	private job(card: LocalDatabaseCard | LocalPositionsCard): Omit<LocalIndexProgress, 'databaseId'> | null {
		return this.bridge.indexing().find((one) => one.databaseId === card.id) ?? card.progress ?? null;
	}

	// Something runs in that tab (indexing, counting, a copy): its label shows the spinner.
	working(tab: ResourceTab): boolean {
		const cards: readonly (LocalDatabaseCard | LocalPositionsCard)[] =
			tab === 'search' ? this.databases() : tab === 'positions' ? this.positionDatabases() : [];
		return cards.some((card) => card.running === true || this.job(card) !== null);
	}

	timeLeft(card: LocalDatabaseCard | LocalPositionsCard): string | null {
		const job = this.job(card);
		if (job?.secondsLeft == null) {
			return null;
		}
		const since = job.at ? Math.max(0, this.now() - job.at) / 1000 : 0;
		return timeLeftLabel(job.secondsLeft - since);
	}

	// Set while the disk has little more room than the run still needs.
	space(card: LocalDatabaseCard | LocalPositionsCard): string | null {
		const room = this.job(card)?.space;
		return room ? `needs ~${this.size(room.needed)}, ${this.size(room.free)} free` : null;
	}

	stage(database: LocalDatabaseCard): string | null {
		const job = this.job(database);
		if (!job) {
			return database.running ? 'Indexing' : null;
		}
		const percent = job.total > 0 ? Math.min(100, Math.floor((job.done / job.total) * 100)) : null;
		if (job.stage === 'converting') {
			return percent === null ? 'Converting the index' : `Converting the index — ${percent}%`;
		}
		if (job.stage === 'compacting') {
			return 'Taking its positions out of the file';
		}
		if (job.stage === 'preparing') {
			return percent === null ? 'Preparing for fast search' : `Preparing for fast search — ${percent}%`;
		}
		if (job.stage === 'exporting') {
			return percent === null ? 'Exporting' : `Exporting — ${percent}%`;
		}
		if (job.stage === 'importing') {
			return percent === null ? 'Importing' : `Importing — ${percent}%`;
		}
		return percent === null ? 'Indexing' : `Indexing — ${percent}%`;
	}

	// One stage for the whole run: reading the games and counting are one percentage.
	counting(positions: LocalPositionsCard): string | null {
		const job = this.job(positions);
		if (!job) {
			return positions.running ? 'Counting positions' : null;
		}
		const percent = job.total > 0 ? Math.min(100, Math.floor((job.done / job.total) * 100)) : null;
		return percent === null ? 'Counting positions' : `Counting positions — ${percent}%`;
	}

	addDatabase(): void {
		void this.run('db.choose', 'db.choose');
	}

	openPicker(): void {
		void this.run('positions.candidates', 'positions.candidates').then((candidates) => {
			if (candidates) {
				this.picker.set(candidates as LocalPositionsCandidates);
			}
		});
	}

	@HostListener('document:keydown.escape')
	closePicker(): void {
		this.picker.set(null);
	}

	fits(choice: LocalPositionsCandidates, candidate: LocalPositionsCandidate): boolean {
		return choice.free === null || choice.free >= candidate.needed;
	}

	addPositions(candidate: LocalPositionsCandidate): void {
		this.picker.set(null);
		void this.run('positions.add', `positions.add:${candidate.databaseId}`, { databaseId: candidate.databaseId });
	}

	// New games counted, or everything again after games were read again.
	updatePositions(positions: LocalPositionsCard): void {
		void this.run('positions.update', `positions.update:${positions.id}`, { positionsId: positions.id });
	}

	removePositions(positions: LocalPositionsCard): void {
		if (this.selection.positionsId() === positions.id) {
			this.selection.selectPositions(null);
		}
		void this.run('positions.remove', `positions.remove:${positions.id}`, { positionsId: positions.id });
	}

	showPositions(positions: LocalPositionsCard): void {
		this.bridge.request('positions.reveal', { positionsId: positions.id }).catch((error: unknown) => {
			this.failure.set(error instanceof Error ? error.message : String(error));
		});
	}

	importDatabase(): void {
		void this.run('db.import', 'db.import');
	}

	// Answers with the file written, or null when the save dialog was closed.
	exportDatabase(database: LocalDatabaseCard): void {
		void this.run('db.export', `db.export:${database.id}`, { databaseId: database.id }).then((file) => {
			if (typeof file === 'string') {
				this.notify.info(`Exported to ${file}`);
			}
		});
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

	// Not through run(): opening the file manager is not an operation the page waits on.
	showDatabase(database: LocalDatabaseCard): void {
		this.bridge.request('db.reveal', { databaseId: database.id }).catch((error: unknown) => {
			this.failure.set(error instanceof Error ? error.message : String(error));
		});
	}

	// Its positions go with it: they cannot be read without its games.
	async removeDatabase(database: LocalDatabaseCard): Promise<void> {
		const positions = this.positionDatabases().find((one) => one.databaseId === database.id);
		if (positions) {
			const sure = await this.confirm.ask(`Remove ${database.name} and its position database?`, {
				confirmLabel: 'Remove both',
				danger: true,
			});
			if (!sure) {
				return;
			}
			if (this.selection.positionsId() === positions.id) {
				this.selection.selectPositions(null);
			}
		}
		if (this.selection.databaseId() === database.id) {
			this.selection.selectDatabase(null);
		}
		void this.run('db.remove', `db.remove:${database.id}`, { databaseId: database.id });
	}

	size(bytes: number): string {
		if (bytes >= 10e9) return `${Math.round(bytes / 1e9)} GB`;
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
	private async run(method: string, tag: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (this.busy() !== null) {
			return undefined;
		}
		this.busy.set(tag);
		this.failure.set(null);
		this.bridge.clearIndexFailure();
		try {
			const value = await this.bridge.request(method, params);
			await this.bridge.refresh();
			return value;
		} catch (error) {
			this.failure.set(error instanceof Error ? error.message : String(error));
			// The version notice, with its download link; it insists when this version is below the minimum.
			if (error instanceof AgentError && error.code === 'NEWER_VERSION') {
				this.updates.recheck();
			}
			return undefined;
		} finally {
			this.busy.set(null);
		}
	}
}
