import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { saveBlob } from '../../core/browser/download';
import { ClipboardStore, LocalClipboardCollection } from '../../core/services/clipboard.store';
import { CollectionApiService } from '../../core/services/collection-api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { NotificationService } from '../../core/services/notification.service';
import {
	COLLECTION_ICONS,
	CollectionIcon,
	CollectionKind,
	CollectionSummary,
	RepertoireColor,
	StorageUsage,
} from '../../core/models/collection.model';
import { AuthService } from '../../core/services/auth.service';
import { SignedOutNoticeComponent } from '../../shared/signed-out/signed-out-notice.component';
import { AgentBridgeService } from '../../core/agent/agent-bridge.service';
import { LocalShelfService } from '../../core/agent/local-shelf.service';
import { LocalSyncService } from '../../core/agent/local-sync.service';
import { CollectionMirrorService } from '../../core/sync/collection-mirror.service';
import { LocalFolderCollection } from '../../core/agent/agent.models';
import { CollectionIconComponent } from './collection-icon.component';
import { BishopLogoComponent } from '../../shared/logo/bishop-logo.component';
import { RookLogoComponent } from '../../shared/logo/rook-logo.component';
import { TooltipDirective } from '../../shared/tooltip/tooltip.directive';
import { fitOnScreen } from '../../core/browser/menu-placement';
import { isOffline } from '../../core/browser/offline';
import { FormValidationDirective } from '../../shared/form-validation/form-validation.directive';

interface Editor {
	readonly editing: CollectionSummary | null;
	// Set instead of `editing` when the collection being edited is a local file, not a server row.
	readonly localEditing: LocalFolderCollection | null;
	readonly name: string;
	readonly icon: CollectionIcon;
}

interface Highlight {
	readonly pre: string;
	readonly match: string;
	readonly post: string;
}

interface CollectionCard {
	readonly collection: CollectionSummary;
	readonly highlight: Highlight;
}

type SortMode = 'manual' | 'alpha-asc' | 'alpha-desc';

/** Each shelf keeps its own order: the cloud's (saved on the server) and this computer's (in the sidecars). */
export type Shelf = 'cloud' | 'local';

type ShelfSource = 'all' | 'cloud' | 'local';

interface LocalCard {
	readonly collection: LocalFolderCollection;
	readonly highlight: Highlight;
}

const MENU_FOOTPRINT = { width: 208, height: 132 };

// Up to four entries (rename, copy, the two removals), against the cloud menu's two.
const LOCAL_MENU_FOOTPRINT = { width: 208, height: 176 };

// Said in place of whatever the request failed with, when the reason is that there is no network.
const CANNOT_PUSH_OFFLINE = 'No internet connection. Cannot push to cloud.';

const CLOUD_UNREACHABLE = 'Cloud collections not reachable. Check your internet connection.';

@Component({
	selector: 'app-collections-page',
	standalone: true,
	imports: [
		NgTemplateOutlet,
		RouterLink,
		CollectionIconComponent,
		TooltipDirective,
		SignedOutNoticeComponent,
		BishopLogoComponent,
		RookLogoComponent,
		FormValidationDirective,
	],
	templateUrl: './collections-page.component.html',
	styleUrl: './collections-page.component.scss',
	host: {
		'(document:click)': 'onDocumentClick($event)',
		'(document:keydown.escape)': 'onEscape()',
		'(document:keydown)': 'onShortcut($event)',
	},
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CollectionsPageComponent {
	private readonly api = inject(CollectionApiService);
	private readonly router = inject(Router);
	private readonly notify = inject(NotificationService);
	private readonly confirmDialog = inject(ConfirmService);
	private readonly clipboard = inject(ClipboardStore);
	readonly auth = inject(AuthService);
	private readonly localShelf = inject(LocalShelfService);
	private readonly sync = inject(LocalSyncService);
	private readonly mirror = inject(CollectionMirrorService);
	readonly bridge = inject(AgentBridgeService);

	readonly kind = input.required<CollectionKind>();
	readonly title = input('Collections');
	readonly description = input('');

	readonly icons = COLLECTION_ICONS;

	readonly color = signal<RepertoireColor>('w');
	readonly collections = signal<readonly CollectionSummary[]>([]);
	readonly loading = signal(false);
	readonly error = signal<string | null>(null);

	readonly selectedIds = signal<ReadonlySet<number>>(new Set());
	// Files on this computer, picked alongside (or instead of) the cloud collections.
	readonly selectedLocalIds = signal<ReadonlySet<string>>(new Set());

	readonly selectionCount = computed(() => this.selectedIds().size + this.selectedLocalIds().size);
	readonly hasSelection = computed(() => this.selectionCount() > 0);

	readonly countSuffix = computed(() => (this.selectionCount() > 1 ? ` (${this.selectionCount()})` : ''));

	// Both shelves go into one zip; a synced collection once, as its file on this device.
	readonly exportSuffix = computed(() => this.countSuffix());

	readonly pasteSuffix = computed(() => {
		const contents = this.pending();
		const size = (contents?.localCollections?.length ?? 0) + (contents?.ids.length ?? 0);
		return size > 1 ? ` (${size})` : '';
	});

	readonly pending = computed(() => this.clipboard.contents());
	readonly canPaste = computed(() => this.pending()?.scope === 'COLLECTIONS');

	readonly menu = signal<{ x: number; y: number; collection: CollectionSummary } | null>(null);

	readonly localMenu = signal<{ x: number; y: number; collection: LocalFolderCollection } | null>(null);

	readonly syncing = signal<string | null>(null);

	readonly account = computed(() => this.auth.currentUser());

	// The account's allowance, so somebody can see what is left before deciding what to keep where.
	readonly storage = signal<StorageUsage | null>(null);

	// True once a cloud list has actually arrived, which is what makes a missing id mean "deleted".
	private readonly cloudLoaded = signal(false);

	// Which cloud collections have a local copy, read from the sidecar beside each file; the
	// server knows nothing about this pairing.
	private readonly localByCloudId = computed(() => {
		const pairs = new Map<number, LocalFolderCollection>();
		for (const collection of this.localCollections()) {
			if (collection.cloudId !== null) {
				pairs.set(collection.cloudId, collection);
			}
		}
		return pairs;
	});
	readonly editor = signal<Editor | null>(null);
	readonly saving = signal(false);

	readonly isRepertoire = computed(() => this.kind() === 'REPERTOIRE');
	readonly cloudSort = signal<SortMode>('manual');
	readonly localSort = signal<SortMode>('manual');
	readonly search = signal('');

	readonly source = signal<ShelfSource>('all');
	readonly localCollections = signal<readonly LocalFolderCollection[]>([]);
	readonly localLoading = signal(false);

	readonly canFilterSource = computed(() => this.bridge.connected());

	readonly localFolderPath = computed(() => this.bridge.backup()?.root ?? null);

	// Signed out, the application still has its shelf on this computer; only a page without one needs an account.
	readonly canUse = computed(() => this.auth.isLoggedIn() || this.bridge.embedded());

	readonly showCloud = computed(() => this.auth.isLoggedIn() && (!this.canFilterSource() || this.source() !== 'local'));
	readonly showLocal = computed(
		() => this.canUse() && this.canFilterSource() && (!this.auth.isLoggedIn() || this.source() !== 'cloud'),
	);

	readonly localCards = computed<readonly LocalCard[]>(() => {
		const query = this.search().trim().toLowerCase();
		let list = this.localCollections();

		if (query) {
			list = list.filter((collection) => collection.name.toLowerCase().includes(query));
		}

		const mode = this.localSort();
		if (mode !== 'manual') {
			const direction = mode === 'alpha-asc' ? 1 : -1;
			list = [...list].sort((a, b) => direction * a.name.localeCompare(b.name));
		}

		return list.map((collection) => ({ collection, highlight: highlightMatch(collection.name, query) }));
	});

	readonly canReorder = computed(() => this.cloudSort() === 'manual' && this.search().trim().length === 0);
	readonly canReorderLocal = computed(() => this.localSort() === 'manual' && this.search().trim().length === 0);

	readonly cards = computed<readonly CollectionCard[]>(() => {
		const query = this.search().trim().toLowerCase();
		let list = this.collections();

		if (query) {
			list = list.filter((collection) => collection.name.toLowerCase().includes(query));
		}

		const mode = this.cloudSort();
		if (mode !== 'manual') {
			const direction = mode === 'alpha-asc' ? 1 : -1;
			list = [...list].sort((a, b) => direction * a.name.localeCompare(b.name));
		}

		return list.map((collection) => ({ collection, highlight: highlightMatch(collection.name, query) }));
	});

	readonly searchEmpty = computed(
		() =>
			!this.loading() &&
			this.collections().length + this.localCollections().length > 0 &&
			this.cards().length + this.localCards().length === 0,
	);

	readonly dragIndex = signal<number | null>(null);
	readonly dropIndex = signal<number | null>(null);
	readonly localDragIndex = signal<number | null>(null);
	readonly localDropIndex = signal<number | null>(null);

	private readonly requestColor = computed<RepertoireColor | null>(() => (this.isRepertoire() ? this.color() : null));

	constructor() {
		effect(() => {
			const kind = this.kind();
			const color = this.requestColor();
			if (!this.auth.isLoggedIn()) {
				this.collections.set([]);
				return;
			}
			this.load(kind, color);
		});

		effect(() => {
			const kind = this.kind();
			const color = this.color();
			const connected = this.bridge.connected();
			void this.loadLocal(kind, kind === 'REPERTOIRE' ? color : null, connected);
		});

		// A copy the mirror rewrote changes what both lists show: counts, sizes, dates.
		let seen = this.mirror.revision();
		effect(() => {
			const revision = this.mirror.revision();
			if (revision !== seen) {
				seen = revision;
				untracked(() => this.reload());
			}
		});
	}

	private load(kind: CollectionKind, color: RepertoireColor | null): void {
		this.loading.set(true);
		this.error.set(null);

		this.api.list(kind, color).subscribe({
			next: (collections) => {
				this.collections.set(collections);
				this.loading.set(false);
				this.cloudLoaded.set(true);
				void this.reconcilePairings();
				this.loadStorage();
			},
			error: (err: Error) => {
				// Only the cloud shelf failed; collections on this computer are read over no
				// network at all, so they stay usable.
				this.error.set(isOffline(err) ? CLOUD_UNREACHABLE : err.message);
				this.collections.set([]);
				this.loading.set(false);
			},
		});
	}

	// The allowance, and what each collection occupies of it, when the server breaks it down.
	private loadStorage(): void {
		this.api.storage().subscribe({
			next: (usage) => this.storage.set(usage),
			error: () => this.storage.set(null),
		});
	}

	// What one cloud collection occupies, if the server broke the figure down.
	cloudBytes(id: number): number | null {
		const usage = this.storage();
		const bytes = usage?.perCollection?.[String(id)];
		return typeof bytes === 'number' ? bytes : null;
	}

	private async loadLocal(kind: CollectionKind, color: RepertoireColor | null, connected: boolean): Promise<void> {
		if (!connected) {
			this.localCollections.set([]);
			return;
		}

		this.localLoading.set(true);
		try {
			this.localCollections.set(await this.localShelf.shelf(kind, color));
		} finally {
			this.localLoading.set(false);
		}
		await this.reconcilePairings();
	}

	// Forgets a local pairing whose cloud collection is gone, so a file doesn't keep claiming to
	// be in two places once the cloud side is deleted.
	private async reconcilePairings(): Promise<void> {
		// Only once a cloud list has actually arrived: before that, an empty list means "not
		// known", not "deleted", and clearing every pairing on that would be worse than the bug.
		if (!this.bridge.embedded() || !this.auth.isLoggedIn() || !this.cloudLoaded()) {
			return;
		}

		// Only when both lists are fresh: a cloud list fetched before a push would drop the new pairing.
		if (this.loading() || this.localLoading()) {
			return;
		}

		const live = new Set(this.collections().map((collection) => collection.id));
		const stale = this.localCollections().filter(
			(collection) => collection.cloudId !== null && !live.has(collection.cloudId),
		);
		if (stale.length === 0) {
			// Both lists in hand and every pairing real: the moment to make sure each pair agrees.
			void this.mirror.syncAll();
			return;
		}

		await Promise.all(stale.map((collection) => this.localShelf.pair(collection.id, null).catch(() => undefined)));
		await this.loadLocal(this.kind(), this.requestColor(), this.bridge.connected());
	}

	private reload(): void {
		if (this.auth.isLoggedIn()) {
			this.load(this.kind(), this.requestColor());
		}
		// The shelf is otherwise only loaded by an effect on kind/colour; a file just created
		// here would not appear until the page was left and reopened without this.
		void this.loadLocal(this.kind(), this.requestColor(), this.bridge.connected());
	}

	setSource(source: ShelfSource): void {
		this.source.set(source);
	}

	openLocal(collection: LocalFolderCollection): void {
		void this.router.navigate([this.basePath(), 'local', collection.id]);
	}

	size(bytes: number): string {
		const units = ['B', 'KB', 'MB', 'GB'];
		let value = bytes;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit++;
		}
		return `${value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
	}

	switchColor(color: RepertoireColor): void {
		this.color.set(color);
	}

	open(collection: CollectionSummary): void {
		this.router.navigate([this.basePath(), 'c', collection.id]);
	}

	onCardClick(event: MouseEvent, collection: CollectionSummary): void {
		if (event.ctrlKey || event.metaKey) {
			event.preventDefault();
			this.toggle(collection.id);
			return;
		}
		this.open(collection);
	}

	isSelected(id: number): boolean {
		return this.selectedIds().has(id);
	}

	private toggle(id: number): void {
		this.clipboard.clear();
		this.selectedIds.update((current) => {
			const next = new Set(current);
			if (!next.delete(id)) {
				next.add(id);
			}
			return next;
		});
	}

	selectAll(): void {
		this.clipboard.clear();
		this.selectedIds.set(new Set(this.showCloud() ? this.cards().map((card) => card.collection.id) : []));
		this.selectedLocalIds.set(new Set(this.showLocal() ? this.localCards().map((card) => card.collection.id) : []));
	}

	clearSelection(): void {
		this.selectedIds.set(new Set());
		this.selectedLocalIds.set(new Set());
	}

	onLocalCardClick(event: MouseEvent, collection: LocalFolderCollection): void {
		if (event.ctrlKey || event.metaKey) {
			event.preventDefault();
			this.clipboard.clear();
			this.selectedLocalIds.update((current) => {
				const next = new Set(current);
				if (!next.delete(collection.id)) {
					next.add(collection.id);
				}
				return next;
			});
			return;
		}
		this.openLocal(collection);
	}

	isLocalSelected(id: string): boolean {
		return this.selectedLocalIds().has(id);
	}

	private localSelectionInOrder(): LocalFolderCollection[] {
		const chosen = this.selectedLocalIds();
		return this.localCards()
			.map((card) => card.collection)
			.filter((collection) => chosen.has(collection.id));
	}

	private selectionInOrder(): number[] {
		const chosen = this.selectedIds();
		return this.cards()
			.map((card) => card.collection.id)
			.filter((id) => chosen.has(id));
	}

	onShortcut(event: KeyboardEvent): void {
		if (this.editor() || isTyping(event.target)) {
			return;
		}
		const modifier = event.ctrlKey || event.metaKey;

		if (modifier && event.key.toLowerCase() === 'a') {
			event.preventDefault();
			this.selectAll();
			return;
		}
		if (modifier && event.key.toLowerCase() === 'c') {
			this.copySelection(true);
			return;
		}
		if (modifier && event.key.toLowerCase() === 'x') {
			this.copySelection(false);
			return;
		}
		if (modifier && event.key.toLowerCase() === 'v') {
			this.paste();
			return;
		}
		if ((event.key === 'Delete' || event.key === 'Backspace') && this.hasSelection()) {
			event.preventDefault();
			void this.removeSelected();
		}
	}

	copySelection(copy: boolean): void {
		const ids = this.selectionInOrder();
		const local = this.localSelectionInOrder();
		const total = ids.length + local.length;
		if (total === 0) {
			return;
		}
		this.clipboard.putCollections(
			ids,
			local.map((collection) => ({ id: collection.id, kind: collection.kind })),
			copy,
			`${total}`,
		);
		const what = total === 1 ? '1 collection' : `${total} collections`;
		// A file on this computer is never moved by a cut; it is copied like with Ctrl+C.
		const note = !copy && local.length > 0 ? ' Files on this device are copied, not moved.' : '';
		this.notify.info(`${what} ${copy ? 'copied' : 'cut'}.${note}`);
	}

	paste(): void {
		const contents = this.clipboard.take('COLLECTIONS');
		if (!contents) {
			return;
		}

		if (contents.localCollections && contents.localCollections.length > 0) {
			void this.pasteLocal(contents.localCollections);
		}
		if (contents.ids.length === 0 || !this.auth.isLoggedIn()) {
			return;
		}

		this.api.transferCollections(this.kind(), this.requestColor(), contents.ids, contents.copy).subscribe({
			next: (moved) => {
				this.clipboard.consumed();
				this.selectedIds.set(new Set(moved.map((collection) => collection.id)));
				this.reload();
			},
			error: (err: Error) => this.notify.error(err.message),
		});
	}

	copyLocal(collection: LocalFolderCollection): void {
		this.closeMenu();
		this.clipboard.putLocalCollections([{ id: collection.id, kind: collection.kind }], collection.name);
		this.notify.info(`"${collection.name}" copied.`);
	}

	// Writes a new file per source, through folder.adopt: same games and icon, a fresh identity,
	// no cloud pairing, and the trunk/type rules of the destination kind/color already applied there.
	private async pasteLocal(sources: readonly LocalClipboardCollection[]): Promise<void> {
		if (!this.localFolderPath()) {
			this.notify.error('Choose a storage folder in Local resources first.');
			return;
		}

		const kind = this.kind();
		const color = this.requestColor();

		try {
			for (const source of sources) {
				const [collection, pgn] = await Promise.all([
					this.localShelf.collection(source.kind, source.id),
					this.localShelf.read(source.id),
				]);
				if (!collection || pgn === null) {
					throw new Error('That collection is no longer on this device.');
				}
				await this.localShelf.adopt({ kind, color, name: collection.name, pgn, cloudId: null, icon: collection.icon });
			}
			this.clipboard.consumed();
			this.reload();
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
		}
	}

	exportShelf(): void {
		if (!this.bridge.embedded()) {
			const ids = this.selectionInOrder();
			this.api.exportArchive(this.kind(), this.requestColor(), ids).subscribe({
				next: (blob) => saveBlob(blob, this.archiveName(ids.length)),
				error: (err: Error) => this.notify.error(err.message),
			});
			return;
		}
		void this.exportBothShelves();
	}

	// Local and cloud in one zip. A synced pair goes in once, as the file on this device; without
	// the cloud (signed out, or not reachable) the zip holds the files on this device only.
	private async exportBothShelves(): Promise<void> {
		const cloudIds = this.selectionInOrder();
		const localPicked = this.localSelectionInOrder();
		const everything = cloudIds.length === 0 && localPicked.length === 0;
		const signedIn = this.auth.isLoggedIn();

		const cloudChosen = !signedIn
			? []
			: everything
				? this.collections()
				: this.collections().filter((collection) => cloudIds.includes(collection.id));
		const twins = this.localByCloudId();
		const local = everything ? [...this.localCollections()] : [...localPicked];
		for (const collection of cloudChosen) {
			const twin = twins.get(collection.id);
			if (twin && !local.includes(twin)) {
				local.push(twin);
			}
		}
		const cloud = cloudChosen.filter((collection) => !twins.has(collection.id));

		try {
			const entries = await Promise.all(
				local.map(async (file) => ({ name: file.name, text: (await this.localShelf.read(file.id)) ?? '' })),
			);
			let blob: Blob;
			try {
				blob = await firstValueFrom(this.api.exportMixed(cloud, entries));
			} catch {
				blob = await firstValueFrom(this.api.exportMixed([], entries));
			}
			saveBlob(blob, this.archiveName(cloudIds.length + localPicked.length));
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
		}
	}

	private archiveName(selected: number): string {
		const shelf = this.isRepertoire() ? `repertoire-${this.color()}` : 'library';
		return selected > 0 ? `${shelf}-selection.zip` : `${shelf}.zip`;
	}

	async removeSelected(): Promise<void> {
		const ids = this.selectionInOrder();
		const local = this.localSelectionInOrder();
		if (ids.length === 0 && local.length === 0) {
			return;
		}
		const chosen = this.collections().filter((collection) => ids.includes(collection.id));
		const games =
			chosen.reduce((total, collection) => total + collection.itemCount, 0) +
			local.reduce((total, collection) => total + collection.itemCount, 0);
		const names = [...chosen.map((collection) => collection.name), ...local.map((collection) => collection.name)];
		const what = names.length === 1 ? `"${names[0]}"` : `${names.length} collections`;
		const paired = this.auth.isLoggedIn() && local.some((collection) => collection.cloudId !== null);
		const where =
			local.length === 0 ? '' : ids.length === 0 ? ' from this device' : ` (${local.length} of them from this device)`;
		const keep = paired ? ' Copies in the cloud that are not selected stay.' : '';

		const confirmed = await this.confirmDialog.ask(
			`Delete ${what}${where} and ${games === 1 ? 'its 1 game' : `their ${games} games`}? This cannot be undone.${keep}`,
			{ confirmLabel: 'Delete', danger: true },
		);
		if (!confirmed) {
			return;
		}

		if (local.length > 0) {
			const failed: string[] = [];
			for (const collection of local) {
				try {
					await this.localShelf.remove(collection.id);
				} catch {
					failed.push(collection.name);
				}
			}
			if (failed.length > 0) {
				this.notify.error(`Could not remove ${failed.map((name) => `"${name}"`).join(', ')} from this device.`);
			}
			if (ids.length === 0) {
				this.clearSelection();
				this.reload();
				return;
			}
		}

		let remaining = ids.length;
		for (const id of ids) {
			this.api.remove(id).subscribe({
				next: () => {
					if (--remaining === 0) {
						this.clearSelection();
						this.reload();
					}
				},
				error: (err: Error) => {
					this.notify.error(err.message);
					if (--remaining === 0) {
						this.clearSelection();
						this.reload();
					}
				},
			});
		}
	}

	private basePath(): string {
		return this.isRepertoire() ? '/repertoire' : '/library';
	}

	startCreate(): void {
		this.closeMenu();
		this.editor.set({ editing: null, localEditing: null, name: '', icon: 'folder' });
	}

	startEdit(collection: CollectionSummary): void {
		this.closeMenu();
		this.editor.set({
			editing: collection,
			localEditing: null,
			name: collection.name,
			icon: (COLLECTION_ICONS as readonly string[]).includes(collection.icon)
				? (collection.icon as CollectionIcon)
				: 'folder',
		});
	}

	startEditLocal(collection: LocalFolderCollection): void {
		this.closeMenu();
		this.editor.set({
			editing: null,
			localEditing: collection,
			name: collection.name,
			icon: (COLLECTION_ICONS as readonly string[]).includes(collection.icon)
				? (collection.icon as CollectionIcon)
				: 'folder',
		});
	}

	onEditorName(event: Event): void {
		const name = (event.target as HTMLInputElement).value;
		this.editor.update((current) => (current ? { ...current, name } : current));
	}

	chooseIcon(icon: CollectionIcon): void {
		this.editor.update((current) => (current ? { ...current, icon } : current));
	}

	closeEditor(): void {
		this.editor.set(null);
	}

	saveEditor(event: Event): void {
		event.preventDefault();

		const editor = this.editor();
		if (!editor || editor.name.trim().length === 0 || this.saving()) {
			return;
		}

		const name = editor.name.trim();

		if (editor.localEditing) {
			void this.saveLocalEdit(editor.localEditing, name, editor.icon);
			return;
		}

		// A new collection is a file on this machine, not a server row, until it is pushed to
		// the cloud: creating one cannot depend on a server being reachable.
		if (!editor.editing && this.bridge.embedded()) {
			if (!this.localFolderPath()) {
				this.notify.error('Choose a storage folder in Local resources first.');
				return;
			}
			this.saving.set(true);
			this.localShelf
				.create(this.kind(), this.requestColor(), name, editor.icon)
				.then(() => {
					this.saving.set(false);
					this.editor.set(null);
					this.reload();
				})
				.catch((error: Error) => {
					this.saving.set(false);
					this.notify.error(error.message);
				});
			return;
		}

		this.saving.set(true);

		const request = editor.editing
			? this.api.update(editor.editing.id, { name, icon: editor.icon })
			: this.api.create(this.kind(), name, editor.icon, this.requestColor());

		const editing = editor.editing;

		request.subscribe({
			next: () => {
				this.saving.set(false);
				this.editor.set(null);
				// Best effort: a name clash on this machine, or a file the user has moved, is
				// not worth failing an edit that already succeeded in the cloud.
				if (editing && this.bridge.embedded()) {
					void this.sync
						.followCloudEdit(editing.id, name, editor.icon, this.localCollections())
						.finally(() => this.reload());
					return;
				}
				this.reload();
			},
			error: (err: Error) => {
				this.saving.set(false);
				this.notify.error(err.message);
			},
		});
	}

	// Renamed before the icon is set: a rename changes the file's id, which the icon write needs.
	private async saveLocalEdit(collection: LocalFolderCollection, name: string, icon: CollectionIcon): Promise<void> {
		this.saving.set(true);
		try {
			let id = collection.id;
			if (name !== collection.name) {
				const renamed = await this.localShelf.rename(id, name);
				id = renamed.id;
			}
			if (icon !== collection.icon) {
				await this.localShelf.setIcon(id, icon);
			}
			// The cloud twin of a paired file follows, as a cloud edit is followed on this computer
			// (LocalSyncService.followCloudEdit). Best effort: the local edit already succeeded.
			if (
				collection.cloudId !== null &&
				this.auth.isLoggedIn() &&
				(name !== collection.name || icon !== collection.icon)
			) {
				await firstValueFrom(this.api.update(collection.cloudId, { name, icon })).catch(() => undefined);
			}
			this.editor.set(null);
			this.reload();
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.saving.set(false);
		}
	}

	openMenu(event: MouseEvent, collection: CollectionSummary): void {
		event.preventDefault();
		const at = fitOnScreen(event.clientX, event.clientY, MENU_FOOTPRINT);
		this.menu.set({ x: at.x, y: at.y, collection });
	}

	closeMenu(): void {
		this.menu.set(null);
		this.localMenu.set(null);
	}

	hasLocalTwin(cloudId: number): boolean {
		return this.localByCloudId().has(cloudId);
	}

	// Adds a copy on this computer; the cloud collection stays exactly where it was.
	pullToLocal(collection: CollectionSummary): void {
		if (this.syncing() !== null || this.hasLocalTwin(collection.id)) {
			return;
		}
		if (!this.localFolderPath()) {
			this.notify.error('Choose a storage folder in Local resources first.');
			return;
		}

		this.syncing.set(`cloud:${collection.id}`);
		this.sync
			.pull(collection)
			.then(() => this.reload())
			.catch((error: Error) => this.notify.error(error.message))
			.finally(() => this.syncing.set(null));
	}

	pushToCloud(collection: LocalFolderCollection): void {
		if (this.syncing() !== null || collection.cloudId !== null) {
			return;
		}
		if (!this.auth.isLoggedIn()) {
			this.notify.error('Sign in to copy a collection to the cloud.');
			return;
		}

		this.syncing.set(`local:${collection.id}`);
		this.sync
			.push(collection)
			.catch((error: Error) => this.notify.error(isOffline(error) ? CANNOT_PUSH_OFFLINE : error.message))
			// Reloaded either way: a failed push may still have changed the file (its uids) or the cards.
			.finally(() => {
				this.syncing.set(null);
				this.reload();
			});
	}

	openLocalMenu(event: MouseEvent, collection: LocalFolderCollection): void {
		event.preventDefault();
		event.stopPropagation();
		const at = fitOnScreen(event.clientX, event.clientY, LOCAL_MENU_FOOTPRINT);
		this.localMenu.set({ x: at.x, y: at.y, collection });
	}

	// Removes one copy, not both.
	async removeLocal(collection: LocalFolderCollection): Promise<void> {
		this.closeMenu();
		const confirmed = await this.confirmDialog.ask(
			collection.cloudId !== null
				? `Remove "${collection.name}" from this device? The copy in the cloud stays.`
				: `Remove "${collection.name}" from this device? This cannot be undone.`,
			{ confirmLabel: 'Remove', danger: true },
		);
		if (!confirmed) {
			return;
		}
		try {
			await this.localShelf.remove(collection.id);
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
		}
		this.reload();
	}

	// Removes the cloud half of a pair, leaving the file here and forgetting what it was paired with.
	async removeCloudTwin(collection: LocalFolderCollection): Promise<void> {
		this.closeMenu();
		if (collection.cloudId === null) {
			return;
		}
		const confirmed = await this.confirmDialog.ask(
			`Remove "${collection.name}" from the cloud? The copy on this device stays.`,
			{ confirmLabel: 'Remove', danger: true },
		);
		if (!confirmed) {
			return;
		}

		const cloudId = collection.cloudId;
		this.api.remove(cloudId).subscribe({
			next: () => {
				void this.localShelf.pair(collection.id, null).finally(() => this.reload());
			},
			error: (err: Error) => this.notify.error(err.message),
		});
	}

	onDocumentClick(event: MouseEvent): void {
		this.closeMenu();

		const target = event.target as HTMLElement | null;
		if (!target || target.closest('.card, .card-slot, .toolbar, .context-menu, .modal')) {
			return;
		}
		this.clearSelection();
	}

	onEscape(): void {
		if (this.menu()) {
			this.closeMenu();
			return;
		}
		if (this.editor()) {
			this.closeEditor();
			return;
		}
		this.clearSelection();
	}

	async remove(): Promise<void> {
		const menu = this.menu();
		if (!menu) {
			return;
		}
		this.closeMenu();

		const { collection } = menu;
		const contents = collection.itemCount === 1 ? '1 game' : `${collection.itemCount} games`;
		const twin = this.localByCloudId().get(collection.id) ?? null;

		// "Cannot be undone" is only true when this is the last copy.
		const confirmed = await this.confirmDialog.ask(
			twin
				? `Delete "${collection.name}" and its ${contents} from the cloud? The copy on this device stays.`
				: `Delete "${collection.name}" and its ${contents} from the cloud? This cannot be undone.`,
			{
				confirmLabel: 'Delete',
				danger: true,
			},
		);
		if (!confirmed) {
			return;
		}

		this.api.remove(collection.id).subscribe({
			next: () => {
				// The mirroring file is standalone; update its sidecar.
				if (twin) {
					void this.localShelf.pair(twin.id, null).finally(() => this.reload());
					return;
				}
				this.reload();
			},
			error: (err: Error) => this.notify.error(err.message),
		});
	}

	onSearch(event: Event): void {
		this.search.set((event.target as HTMLInputElement).value);
	}

	sortOf(shelf: Shelf): SortMode {
		return shelf === 'cloud' ? this.cloudSort() : this.localSort();
	}

	useManualOrder(shelf: Shelf): void {
		(shelf === 'cloud' ? this.cloudSort : this.localSort).set('manual');
	}

	toggleAlphabetical(shelf: Shelf): void {
		(shelf === 'cloud' ? this.cloudSort : this.localSort).update((mode) =>
			mode === 'alpha-asc' ? 'alpha-desc' : 'alpha-asc',
		);
	}

	onLocalDragStart(event: DragEvent, index: number): void {
		if (!this.canReorderLocal()) {
			event.preventDefault();
			return;
		}
		this.localDragIndex.set(index);
		const card = this.localCards()[index];
		event.dataTransfer?.setData('text/plain', card?.collection.id ?? '');
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
	}

	onLocalDragOver(event: DragEvent, index: number): void {
		if (this.localDragIndex() === null) {
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		this.localDropIndex.set(event.clientX < box.left + box.width / 2 ? index : index + 1);
	}

	onLocalDragEnd(): void {
		this.localDragIndex.set(null);
		this.localDropIndex.set(null);
	}

	onLocalDrop(event: DragEvent): void {
		event.preventDefault();
		const from = this.localDragIndex();
		const to = this.localDropIndex();
		this.onLocalDragEnd();
		if (from !== null && to !== null) {
			void this.moveLocalCard(from, to);
		}
	}

	// The whole shelf is written in its new order: files never placed before get a place too.
	private async moveLocalCard(from: number, to: number): Promise<void> {
		const current = this.localCollections();
		const moved = current[from];
		const target = to > from ? to - 1 : to;
		if (!moved || target === from) {
			return;
		}

		const next = [...current];
		next.splice(from, 1);
		next.splice(target, 0, moved);
		this.localCollections.set(next.map((collection, index) => ({ ...collection, sortOrder: index })));

		try {
			await this.localShelf.setOrder(next.map((collection) => collection.id));
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
			this.reload();
		}
	}

	onCardDragStart(event: DragEvent, index: number): void {
		if (!this.canReorder()) {
			event.preventDefault();
			return;
		}
		this.dragIndex.set(index);
		const card = this.cards()[index];
		event.dataTransfer?.setData('text/plain', String(card?.collection.id ?? ''));
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
	}

	onCardDragOver(event: DragEvent, index: number): void {
		if (this.dragIndex() === null) {
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}

		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const gap = event.clientX < box.left + box.width / 2 ? index : index + 1;
		this.dropIndex.set(gap);
	}

	onCardDragEnd(): void {
		this.dragIndex.set(null);
		this.dropIndex.set(null);
	}

	onCardDrop(event: DragEvent): void {
		event.preventDefault();
		const from = this.dragIndex();
		const to = this.dropIndex();
		this.onCardDragEnd();

		if (from !== null && to !== null) {
			this.moveCard(from, to);
		}
	}

	private moveCard(from: number, to: number): void {
		const current = this.collections();
		const moved = current[from];
		if (!moved) {
			return;
		}

		// `to` is a gap, so lifting the card out shifts everything after it up by one.
		const target = to > from ? to - 1 : to;
		if (target === from) {
			return;
		}

		const next = [...current];
		next.splice(from, 1);
		next.splice(target, 0, moved);

		const renumbered = next.map((collection, index) => ({ ...collection, sortOrder: index }));
		this.collections.set(renumbered);

		const changed = renumbered.filter((collection) => {
			const before = current.find((c) => c.id === collection.id);
			return before === undefined || before.sortOrder !== collection.sortOrder;
		});

		for (const collection of changed) {
			this.api.update(collection.id, { sortOrder: collection.sortOrder }).subscribe({
				error: (err: Error) => {
					this.notify.error(err.message);
					this.reload();
				},
			});
		}
	}
}

function highlightMatch(name: string, query: string): Highlight {
	if (!query) {
		return { pre: name, match: '', post: '' };
	}
	const index = name.toLowerCase().indexOf(query);
	if (index === -1) {
		return { pre: name, match: '', post: '' };
	}
	return {
		pre: name.slice(0, index),
		match: name.slice(index, index + query.length),
		post: name.slice(index + query.length),
	};
}

function isTyping(target: EventTarget | null): boolean {
	const element = target as HTMLElement | null;
	if (!element) {
		return false;
	}
	const tag = element.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}
