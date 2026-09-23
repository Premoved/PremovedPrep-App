import {
	ChangeDetectionStrategy,
	Component,
	computed,
	effect,
	inject,
	input,
	linkedSignal,
	output,
	signal,
	untracked,
} from '@angular/core';
import { map, switchMap } from 'rxjs';
import { LocalFolderCollection, LocalOpenEntry } from '../../../core/agent/agent.models';
import { isOffline } from '../../../core/browser/offline';
import { AgentBridgeService } from '../../../core/agent/agent-bridge.service';
import { LocalShelfService } from '../../../core/agent/local-shelf.service';
import { DEFAULT_FEN } from '../../../core/chess/fen.util';
import { GameHeaders } from '../../../core/chess/game-headers';
import { composePgnFile } from '../../../core/chess/pgn-file';
import { PgnSerializerService } from '../../../core/chess/pgn-serializer.service';
import {
	COLLECTION_ICONS,
	CollectionKind,
	CollectionSummary,
	ITEM_TYPES_BY_KIND,
	ITEM_TYPE_LABEL,
	ItemType,
	RepertoireColor,
} from '../../../core/models/collection.model';
import { AuthService } from '../../../core/services/auth.service';
import { CollectionApiService } from '../../../core/services/collection-api.service';
import { TimeControlApiService } from '../../../core/services/time-control-api.service';
import { NotificationService } from '../../../core/services/notification.service';
import { CloudStorageService } from '../../../core/services/cloud-storage.service';
import { DatePickerComponent } from '../../../shared/date-picker/date-picker.component';
import { CollectionIconComponent } from '../../collections/collection-icon.component';
import { MoveTreeStore } from '../state/move-tree.store';

export type GameFilePanel = 'data' | 'location';

export interface SavedEntry {
	readonly itemId: number | null;
	readonly collectionId: number | null;
	readonly localItemId?: string;
	readonly localCollectionId?: string;
}

export interface Destination {
	readonly where: 'cloud' | 'local';
	// Cloud collection id, or the local file's own id.
	readonly id: number | string;
	readonly name: string;
	readonly icon: string;
	readonly itemCount: number;
}

function sameDestination(left: Destination | null, right: Destination | null): boolean {
	return left !== null && right !== null && left.where === right.where && left.id === right.id;
}

type Draft = Record<string, string>;

const RESULTS: readonly string[] = ['1-0', '1/2-1/2', '0-1', '*'];

const BUILT_IN_TIME_CONTROLS: readonly string[] = ['5400+30', '1800+10', '900+10', '600+0', '180+2'];

interface TimeControlOption {
	readonly value: string;
	readonly mine: boolean;
}

const DOCUMENT_TYPES: readonly ItemType[] = ['ANALYSIS', 'STUDY', 'MAIN_LINE'];

const COLOR_LABEL: Readonly<Record<RepertoireColor, string>> = { w: 'White', b: 'Black' };

const CLOUD_UNREACHABLE = 'Cloud collections not reachable. Check your internet connection.';

@Component({
	selector: 'app-game-file-dialog',
	standalone: true,
	imports: [CollectionIconComponent, DatePickerComponent],
	templateUrl: './game-file-dialog.component.html',
	styleUrl: './game-file-dialog.component.scss',
	host: {
		'(document:keydown.escape)': 'closed.emit()',
		'(document:click)': 'closeTimeMenu()',
	},
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameFileDialogComponent {
	private readonly api = inject(CollectionApiService);
	private readonly auth = inject(AuthService);
	private readonly notify = inject(NotificationService);
	private readonly cloud = inject(CloudStorageService);
	private readonly shelf = inject(LocalShelfService);
	private readonly bridge = inject(AgentBridgeService);
	private readonly serializer = inject(PgnSerializerService);
	private readonly tree = inject(MoveTreeStore);
	private readonly timeControls = inject(TimeControlApiService);

	readonly panel = input<GameFilePanel>('data');

	readonly openItemId = input<number | null>(null);

	readonly openLocalEntry = input<LocalOpenEntry | null>(null);

	readonly closed = output<void>();
	readonly saved = output<SavedEntry>();

	readonly activePanel = linkedSignal<GameFilePanel>(() => this.panel());

	readonly results = RESULTS;
	readonly icons = COLLECTION_ICONS;
	readonly shelves: readonly CollectionKind[] = ['LIBRARY', 'REPERTOIRE'];
	readonly colors: readonly RepertoireColor[] = ['w', 'b'];

	private readonly savedTimeControls = signal<readonly string[]>([]);

	readonly tcOpen = signal(false);

	readonly tcOther = signal(false);

	readonly timeControlOptions = computed<readonly TimeControlOption[]>(() => {
		const mine = this.savedTimeControls();
		const current = (this.draft()['timeControl'] ?? '').trim();
		const values = [...new Set([...(current.length > 0 ? [current] : []), ...BUILT_IN_TIME_CONTROLS, ...mine])];
		return values.map((value) => ({ value, mine: mine.includes(value) }));
	});

	readonly kind = signal<CollectionKind>('LIBRARY');
	readonly color = signal<RepertoireColor>('w');

	private readonly home = signal<Destination | null>(null);

	readonly cloudFolders = signal<readonly Destination[]>([]);
	readonly localFolders = signal<readonly Destination[]>([]);
	readonly loading = signal(false);
	readonly cloudFailure = signal<string | null>(null);
	readonly selected = signal<Destination | null>(null);
	readonly saving = signal(false);

	readonly hasLocal = computed(() => this.bridge.embedded());

	readonly creatingFolder = signal(false);
	readonly newFolderName = signal('');
	readonly newFolderIcon = signal<string>('folder');
	readonly newFolderWhere = signal<'cloud' | 'local'>('cloud');

	readonly itemType = signal<ItemType>(this.defaultTypeFor('LIBRARY'));
	readonly types = computed(() => ITEM_TYPES_BY_KIND[this.kind()]);

	readonly isDocument = computed(() => DOCUMENT_TYPES.includes(this.itemType()));

	// Seeded from the live tree headers and the type guessed above, so a document's title/author
	// (Event/Annotator) show correctly on the very first render, not just after locate*Entry() corrects it.
	readonly draft = signal<Draft>(this.draftOf(this.tree.headers(), this.isDocument()));

	readonly firstLabel = computed(() => (this.isDocument() ? 'Title' : 'White'));
	readonly secondLabel = computed(() => (this.isDocument() ? 'Author' : 'Black'));

	readonly path = computed(() => {
		const parts: string[] = [this.kind() === 'LIBRARY' ? 'library' : 'repertoire'];
		if (this.kind() === 'REPERTOIRE') {
			parts.push(COLOR_LABEL[this.color()].toLowerCase());
		}
		const folder = this.selected();
		if (folder) {
			parts.push(folder.name);
		}
		return parts;
	});

	readonly userName = computed(() =>
		this.selected()?.where === 'local' ? 'this computer' : (this.auth.currentUser()?.username ?? 'you'),
	);

	readonly canSave = computed(() => this.selected() !== null && !this.saving());

	readonly isOpen = computed(() => this.openItemId() !== null || this.openLocalEntry() !== null);

	readonly writesBack = computed(() => this.isOpen() && sameDestination(this.selected(), this.home()));

	readonly saveLabel = computed(() => {
		if (this.saving()) {
			return 'Saving…';
		}
		return this.isOpen() && !this.writesBack() ? 'Save a copy' : 'Save';
	});

	constructor() {
		this.load();
		this.loadTimeControls();

		// Effect, not a direct read: Angular writes inputs after construction, so openItemId()
		// would read null if read from the constructor body.
		let located: number | null = null;
		effect(() => {
			const itemId = this.openItemId();
			if (itemId === null || itemId === located) {
				return;
			}
			located = itemId;
			untracked(() => this.locateOpenEntry(itemId));
		});

		let locatedLocal: string | null = null;
		effect(() => {
			const entry = this.openLocalEntry();
			if (entry === null || entry.id === locatedLocal) {
				return;
			}
			locatedLocal = entry.id;
			untracked(() => this.adoptLocalEntry(entry));
		});
	}

	private adoptLocalEntry(entry: LocalOpenEntry): void {
		this.kind.set(entry.kind);
		if (entry.color !== null) {
			this.color.set(entry.color);
		}

		// Local entry ids are "<fileId>#<index>".
		const [file] = entry.id.split('#');
		const home: Destination = { where: 'local', id: file, name: '', icon: 'folder', itemCount: 0 };
		this.home.set(home);
		this.selected.set(home);

		const type = ITEM_TYPES_BY_KIND[entry.kind].includes(entry.itemType)
			? entry.itemType
			: this.defaultTypeFor(entry.kind);
		this.itemType.set(type);

		this.draft.set(this.draftOf(this.tree.headers(), DOCUMENT_TYPES.includes(type)));

		if (entry.kind !== 'LIBRARY') {
			this.load();
			return;
		}
		this.restoreSelection();
	}

	private locateOpenEntry(itemId: number): void {
		this.api
			.getItem(itemId)
			.pipe(
				switchMap((detail) =>
					this.api.get(detail.collectionId).pipe(map((folder) => ({ folder, itemType: detail.itemType }))),
				),
			)
			.subscribe({
				next: ({ folder, itemType }) => {
					const home = cloudDestination(folder);
					this.home.set(home);
					this.kind.set(folder.kind);
					if (folder.color !== null) {
						this.color.set(folder.color);
					}
					this.selected.set(home);

					const type = ITEM_TYPES_BY_KIND[folder.kind].includes(itemType) ? itemType : this.defaultTypeFor(folder.kind);
					this.itemType.set(type);

					this.draft.set(this.draftOf(this.tree.headers(), DOCUMENT_TYPES.includes(type)));

					if (folder.kind !== 'LIBRARY') {
						this.load();
					}
				},
				error: () => {
					// List stays as it was; this dialog has no way to surface the failure.
				},
			});
	}

	private loadTimeControls(): void {
		if (!this.auth.currentUser()) {
			return;
		}
		this.timeControls.list().subscribe({
			next: (list) => this.savedTimeControls.set(list.map((entry) => entry.value)),
			error: () => this.savedTimeControls.set([]),
		});
	}

	toggleTimeMenu(event: Event): void {
		event.stopPropagation();
		this.tcOther.set(false);
		this.tcOpen.update((open) => !open);
	}

	closeTimeMenu(): void {
		this.tcOpen.set(false);
	}

	pickTimeControl(value: string): void {
		this.setField('timeControl', value);
		this.tcOpen.set(false);
	}

	startOtherTimeControl(): void {
		this.tcOpen.set(false);
		this.tcOther.set(true);
	}

	commitTimeControl(): void {
		const value = (this.draft()['timeControl'] ?? '').trim();
		this.setField('timeControl', value);
		this.tcOther.set(false);

		const known = this.timeControlOptions().some((option) => option.value === value);
		if (value.length === 0 || known || !this.auth.currentUser()) {
			return;
		}
		this.timeControls.create(value).subscribe({
			next: () => this.loadTimeControls(),
			error: () => undefined,
		});
	}

	show(panel: GameFilePanel): void {
		this.activePanel.set(panel);
	}

	labelFor(type: ItemType): string {
		return ITEM_TYPE_LABEL[type];
	}

	shelfLabel(kind: CollectionKind): string {
		return kind === 'LIBRARY' ? 'Library' : 'Repertoire';
	}

	colorLabel(color: RepertoireColor): string {
		return COLOR_LABEL[color];
	}

	valueOf(key: string): string {
		return this.draft()[key] ?? '';
	}

	onField(key: string, event: Event): void {
		const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
		this.setField(key, value);
	}

	setField(key: string, value: string): void {
		this.draft.update((current) => ({ ...current, [key]: value }));
	}

	chooseType(type: ItemType): void {
		this.itemType.set(type);
	}

	applyData(event: Event): void {
		event.preventDefault();

		if (this.selected() !== null) {
			this.write();
			return;
		}

		this.tree.setHeaders(this.headers());
		this.notify.info('Game data updated.');
		this.activePanel.set('location');
	}

	readonly applySaves = computed(() => this.selected() !== null && !this.saving());

	readonly applyLabel = computed(() => {
		if (!this.applySaves()) {
			return 'Apply';
		}
		return this.saving() ? 'Saving…' : this.saveLabel();
	});

	private headers(): GameHeaders {
		const draft = this.draft();

		const edited: Draft = {
			whiteElo: draft['firstElo'] ?? '',
			blackElo: draft['secondElo'] ?? '',
			result: draft['result'] ?? '',
			event: draft['event'] ?? '',
			site: draft['site'] ?? '',
			date: draft['date'] ?? '',
			round: draft['round'] ?? '',
			timeControl: draft['timeControl'] ?? '',
			annotator: draft['annotator'] ?? '',
			white: draft['first'] ?? '',
			black: draft['second'] ?? '',
		};

		if (this.isDocument()) {
			edited['event'] = draft['event'] || draft['first'] || '';
			edited['annotator'] = draft['annotator'] || draft['second'] || '';
			edited['white'] = '';
			edited['black'] = '';
		}

		// Roster first, edited fields on top: preserves tags the form doesn't expose (e.g. Termination).
		const merged: Record<string, string> = { ...this.rosterOf(this.tree.headers()), ...edited };
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(merged)) {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				headers[key] = trimmed;
			}
		}

		// rosterOf only copies string values; variant/extra are objects and must be carried by hand.
		const current = this.tree.headers();
		return { ...(headers as GameHeaders), variant: current.variant, extra: current.extra };
	}

	// A document keeps its title/author in the Event/Annotator tags, not White/Black.
	private draftOf(headers: GameHeaders, document: boolean): Draft {
		return {
			first: (document ? headers.event : headers.white) ?? '',
			second: (document ? headers.annotator : headers.black) ?? '',
			firstElo: headers.whiteElo ?? '',
			secondElo: headers.blackElo ?? '',
			result: headers.result ?? '*',
			event: document ? '' : (headers.event ?? ''),
			site: headers.site ?? '',
			date: headers.date ?? '',
			round: headers.round ?? '',
			timeControl: headers.timeControl ?? '',
			annotator: document ? '' : (headers.annotator ?? ''),
		};
	}

	private rosterOf(headers: GameHeaders): Record<string, string> {
		const roster: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			if (typeof value === 'string') {
				roster[key] = value;
			}
		}
		return roster;
	}

	selectShelf(kind: CollectionKind): void {
		if (this.kind() === kind) {
			return;
		}
		this.kind.set(kind);
		this.itemType.set(this.defaultTypeFor(kind));
		this.reload();
	}

	selectColor(color: RepertoireColor): void {
		if (this.color() === color) {
			return;
		}
		this.color.set(color);
		this.reload();
	}

	private reload(): void {
		this.selected.set(null);
		this.creatingFolder.set(false);
		this.load();
	}

	private load(): void {
		const kind = this.kind();
		const color = kind === 'REPERTOIRE' ? this.color() : null;
		this.loading.set(true);
		this.cloudFailure.set(null);

		if (this.auth.currentUser()) {
			this.api.list(kind, color).subscribe({
				next: (folders) => {
					this.cloudFolders.set(folders.map(cloudDestination));
					this.loading.set(false);
					this.restoreSelection();
				},
				error: (err: Error) => {
					// No notification: this dialog is saving locally, so a cloud-list failure
					// isn't a failure of what the user is actually doing.
					this.loading.set(false);
					this.cloudFolders.set([]);
					this.cloudFailure.set(isOffline(err) ? CLOUD_UNREACHABLE : err.message);
				},
			});
		} else {
			this.cloudFolders.set([]);
			this.cloudFailure.set(null);
			this.loading.set(false);
		}

		if (this.hasLocal()) {
			void this.shelf
				.shelf(kind, color)
				.then((folders) => {
					this.localFolders.set(folders.map(localDestination));
					this.restoreSelection();
				})
				.catch(() => this.localFolders.set([]));
		} else {
			this.localFolders.set([]);
		}
	}

	private restoreSelection(): void {
		const home = this.home();
		if (home === null) {
			return;
		}
		const real = this.destinations().find((one) => sameDestination(one, home));
		if (!real) {
			return;
		}
		if (real.name !== home.name) {
			this.home.set(real);
		}
		if (sameDestination(this.selected(), home)) {
			this.selected.set(real);
		}
	}

	readonly destinations = computed<readonly Destination[]>(() => [...this.cloudFolders(), ...this.localFolders()]);

	select(folder: Destination): void {
		this.selected.set(folder);
	}

	isSelected(folder: Destination): boolean {
		return sameDestination(this.selected(), folder);
	}

	chooseWhere(where: 'cloud' | 'local'): void {
		this.newFolderWhere.set(where);
	}

	startFolder(): void {
		this.creatingFolder.set(true);
		this.newFolderName.set('');
		this.newFolderIcon.set('folder');
	}

	cancelFolder(): void {
		this.creatingFolder.set(false);
	}

	onNewFolderName(event: Event): void {
		this.newFolderName.set((event.target as HTMLInputElement).value);
	}

	chooseIcon(icon: string): void {
		this.newFolderIcon.set(icon);
	}

	createFolder(event: Event): void {
		event.preventDefault();

		const kind = this.kind();
		const name = this.newFolderName().trim();
		if (name.length === 0) {
			return;
		}

		const color = kind === 'REPERTOIRE' ? this.color() : null;

		if (this.newFolderWhere() === 'local' && this.hasLocal()) {
			void this.shelf
				.create(kind, color, name)
				.then((folder) => {
					const made = localDestination(folder);
					this.creatingFolder.set(false);
					this.localFolders.update((list) => [...list, made]);
					this.selected.set(made);
				})
				.catch((error: Error) => this.notify.error(error.message));
			return;
		}

		this.api.create(kind, name, this.newFolderIcon(), color).subscribe({
			next: (folder) => {
				const made = cloudDestination(folder);
				this.creatingFolder.set(false);
				this.cloudFolders.update((list) => [...list, made]);
				this.selected.set(made);
			},
			error: (err: Error) => this.notify.error(err.message),
		});
	}

	save(event: Event): void {
		event.preventDefault();
		this.write();
	}

	private write(): void {
		const destination = this.selected();
		if (destination === null || this.saving()) {
			return;
		}

		const headers = this.headers();
		this.tree.setHeaders(headers);
		this.saving.set(true);

		const draft = this.draft();
		const title = this.isDocument() ? draft['first']?.trim() || headers.event : undefined;
		const author = this.isDocument() ? draft['second']?.trim() || undefined : undefined;

		if (destination.where === 'local') {
			void this.writeLocally(destination, this.pgn(headers), title || undefined);
			return;
		}

		const collectionId = destination.id as number;
		const openItemId = this.openItemId();
		const written =
			this.writesBack() && openItemId !== null
				? this.api.updateItem(openItemId, this.pgn(headers), title || undefined, author, this.itemType())
				: this.api.createItem(collectionId, this.itemType(), this.pgn(headers), title || undefined, author);

		written.subscribe({
			next: (item) => {
				this.saving.set(false);
				this.cloud.refresh();
				this.saved.emit({ itemId: item.id, collectionId });
			},
			error: (err: Error) => {
				this.saving.set(false);
				if (this.cloud.reportFull(err)) {
					this.closed.emit();
					return;
				}
				this.notify.error(err.message);
			},
		});
	}

	private async writeLocally(destination: Destination, pgn: string, title: string | undefined): Promise<void> {
		const file = destination.id as string;
		const open = this.openLocalEntry();

		try {
			if (this.writesBack() && open !== null) {
				await this.shelf.replaceEntry(open.id, pgn);
				this.saved.emit({
					itemId: null,
					collectionId: null,
					localItemId: open.id,
					localCollectionId: file,
				});
				return;
			}

			const result = await this.shelf.append(file, pgn, { itemType: this.itemType(), title });
			this.saved.emit({
				itemId: null,
				collectionId: null,
				localItemId: `${file}#${Math.max(0, result.total - 1)}`,
				localCollectionId: file,
			});
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.saving.set(false);
		}
	}

	private pgn(headers: GameHeaders): string {
		const root = this.tree.root();
		return composePgnFile({
			headers,
			startFen: root?.fen ?? DEFAULT_FEN,
			movetext: this.serializer.movetext(root),
			annotator: headers.annotator ?? null,
		});
	}

	private defaultTypeFor(kind: CollectionKind): ItemType {
		if (kind === 'REPERTOIRE') {
			return 'MAIN_LINE';
		}
		const fen = this.tree.root()?.fen;
		return fen && fen !== DEFAULT_FEN ? 'STUDY' : 'ANALYSIS';
	}
}

function cloudDestination(folder: CollectionSummary): Destination {
	return { where: 'cloud', id: folder.id, name: folder.name, icon: folder.icon, itemCount: folder.itemCount };
}

function localDestination(folder: LocalFolderCollection): Destination {
	return { where: 'local', id: folder.id, name: folder.name, icon: folder.icon, itemCount: folder.itemCount };
}
