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
import { withTag } from '../../../core/chess/pgn-metadata';
import { TYPE_TAG } from '../../../core/sync/collection-mirror.service';
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
import { TimeControlsStore } from '../../../core/services/time-controls.store';
import {
	FIDE_TIME_CONTROLS,
	TIME_CONTROL_CATEGORIES,
	parseTimeControl,
	pgnForName,
	timeControlLabel,
} from '../../../core/chess/time-control';
import { NotificationService } from '../../../core/services/notification.service';
import { CloudStorageService } from '../../../core/services/cloud-storage.service';
import { DatePickerComponent } from '../../../shared/date-picker/date-picker.component';
import { CollectionIconComponent } from '../../collections/collection-icon.component';
import { MoveTreeStore } from '../state/move-tree.store';
import { FormValidationDirective } from '../../../shared/form-validation/form-validation.directive';

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

interface TimeControlChoice {
	readonly name: string;
	/** The PGN TimeControl it stands for; null for a name that cannot be read as one. */
	readonly pgn: string | null;
	// Saved by the user rather than one of FIDE's, which is what the marker in the list means.
	readonly mine: boolean;
}

interface TimeControlGroup {
	readonly label: string;
	readonly options: readonly TimeControlChoice[];
}

const COLOR_LABEL: Readonly<Record<RepertoireColor, string>> = { w: 'White', b: 'Black' };

const CLOUD_UNREACHABLE = 'Cloud collections not reachable. Check your internet connection.';

@Component({
	selector: 'app-game-file-dialog',
	standalone: true,
	imports: [CollectionIconComponent, DatePickerComponent, FormValidationDirective],
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
	private readonly timeControlStore = inject(TimeControlsStore);

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

	readonly tcOpen = signal(false);

	// True while a time control the list does not hold is being typed.
	readonly tcOther = signal(false);

	// What is typed in Custom…, kept apart from the game data until it is committed.
	readonly tcTyped = signal('');

	readonly typedPgn = computed(() => parseTimeControl(this.tcTyped()));

	// FIDE's own time controls by category, then the ones the user saved.
	readonly timeControlGroups = computed<readonly TimeControlGroup[]>(() => {
		const groups: TimeControlGroup[] = TIME_CONTROL_CATEGORIES.map((category) => ({
			label: category,
			options: FIDE_TIME_CONTROLS.filter((preset) => preset.category === category).map((preset) => ({
				name: preset.name,
				pgn: preset.pgn,
				mine: false,
			})),
		}));
		const mine = this.timeControlStore.mine().map((name) => ({ name, pgn: pgnForName(name), mine: true }));
		if (mine.length > 0) {
			groups.push({ label: 'Mine', options: mine });
		}
		return groups;
	});

	// The game's own name for its time control, or the reading of its TimeControl.
	readonly timeControlShown = computed(
		() => timeControlLabel(this.draft()['timeControlName'], this.draft()['timeControl']) ?? '',
	);

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

	// Signed out, only this computer is left to save to.
	readonly hasCloud = computed(() => this.auth.isLoggedIn());

	readonly creatingFolder = signal(false);
	readonly newFolderName = signal('');
	readonly newFolderIcon = signal<string>('folder');
	readonly newFolderWhere = signal<'cloud' | 'local'>('cloud');

	readonly itemType = signal<ItemType>(this.defaultTypeFor('LIBRARY'));
	readonly types = computed(() => ITEM_TYPES_BY_KIND[this.kind()]);

	// The same fields for every type: choosing a type changes what the entry does, not what it holds.
	readonly draft = signal<Draft>(this.draftOf(this.tree.headers()));

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
		this.selected()?.where === 'local' ? 'this device' : (this.auth.currentUser()?.username ?? 'you'),
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
		this.timeControlStore.refresh();

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

					if (folder.kind !== 'LIBRARY') {
						this.load();
					}
				},
				error: () => {
					// List stays as it was; this dialog has no way to surface the failure.
				},
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

	pickTimeControl(choice: TimeControlChoice | null): void {
		this.setField('timeControlName', choice?.name ?? '');
		this.setField('timeControl', choice?.pgn ?? '');
		this.tcOpen.set(false);
	}

	startOtherTimeControl(): void {
		this.tcOpen.set(false);
		this.tcTyped.set(this.timeControlShown());
		this.tcOther.set(true);
	}

	onTypedTimeControl(event: Event): void {
		this.tcTyped.set((event.target as HTMLInputElement).value);
	}

	// Never an error: a name that cannot be read as a time control is kept as written, and the
	// TimeControl tag is left out rather than guessed.
	commitTimeControl(): void {
		if (!this.tcOther()) {
			return;
		}
		const name = this.tcTyped().trim();
		this.tcOther.set(false);
		this.setField('timeControlName', name);
		this.setField('timeControl', name.length > 0 ? (pgnForName(name) ?? '') : '');
		this.timeControlStore.save(name);
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
			timeControlName: draft['timeControlName'] ?? '',
			annotator: draft['annotator'] ?? '',
			white: draft['first'] ?? '',
			black: draft['second'] ?? '',
		};

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

	private draftOf(headers: GameHeaders): Draft {
		return {
			first: headers.white ?? '',
			second: headers.black ?? '',
			firstElo: headers.whiteElo ?? '',
			secondElo: headers.blackElo ?? '',
			result: headers.result ?? '*',
			event: headers.event ?? '',
			site: headers.site ?? '',
			date: headers.date ?? '',
			round: headers.round ?? '',
			timeControl: headers.timeControl ?? '',
			timeControlName: headers.timeControlName ?? '',
			annotator: headers.annotator ?? '',
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

		if ((this.newFolderWhere() === 'local' || !this.hasCloud()) && this.hasLocal()) {
			void this.shelf
				.create(kind, color, name, this.newFolderIcon())
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

		if (destination.where === 'local') {
			// The type travels in the file's own tag; one carried over from where the game was opened
			// would otherwise win over the type just chosen.
			void this.writeLocally(destination, withTag(this.pgn(headers), TYPE_TAG, this.itemType()));
			return;
		}

		const collectionId = destination.id as number;
		const openItemId = this.openItemId();
		const written =
			this.writesBack() && openItemId !== null
				? this.api.updateItem(openItemId, this.pgn(headers), this.itemType())
				: this.api.createItem(collectionId, this.itemType(), this.pgn(headers));

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

	private async writeLocally(destination: Destination, pgn: string): Promise<void> {
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

			const result = await this.shelf.append(file, pgn, { itemType: this.itemType() });
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
		return fen && fen !== DEFAULT_FEN ? 'STUDY' : 'GAME';
	}
}

function cloudDestination(folder: CollectionSummary): Destination {
	return { where: 'cloud', id: folder.id, name: folder.name, icon: folder.icon, itemCount: folder.itemCount };
}

function localDestination(folder: LocalFolderCollection): Destination {
	return { where: 'local', id: folder.id, name: folder.name, icon: folder.icon, itemCount: folder.itemCount };
}
