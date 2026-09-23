import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '../../core/services/auth.service';
import { AgentBridgeService } from '../../core/agent/agent-bridge.service';
import { LocalShelfService } from '../../core/agent/local-shelf.service';
import { LocalSyncService } from '../../core/agent/local-sync.service';
import { LocalFolderCollection, LocalFolderEntry, LocalFolderEntryDetail } from '../../core/agent/agent.models';
import { CollectionKind, ITEM_TYPES_BY_KIND, ITEM_TYPE_LABEL, ItemType } from '../../core/models/collection.model';
import { isLoadableFen } from '../../core/chess/fen.util';
import { ClipboardStore } from '../../core/services/clipboard.store';
import { CollectionApiService } from '../../core/services/collection-api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { NotificationService } from '../../core/services/notification.service';
import { TabsStore } from '../../core/tabs/tabs.store';
import { ViewportService } from '../../core/layout/viewport.service';
import { saveBlob } from '../../core/browser/download';
import { fitOnScreen } from '../../core/browser/menu-placement';
import { isOffline } from '../../core/browser/offline';
import { scrollIntoContainer, scrollableAncestor } from '../../core/browser/scroll';
import { PreviewBoardComponent } from './preview-board/preview-board.component';
import { CollectionIconComponent } from './collection-icon.component';

const MENU_FOOTPRINT = { width: 200, height: 44 };

// Clears the horizontal scrollbar, which overlaps the list's last visible pixels.
const ROW_CLEARANCE_PX = 24;

const MIN_PREVIEW_PX = 300;

const DEFAULT_PREVIEW_PX = 380;

const HANDLE_MARGIN_PX = 24;

const LIST_GUTTER_PX = 20;

// Matches the preview-sheet-up keyframe duration in the stylesheet.
const SHEET_ENTER_MS = 240;

const DRAG_THRESHOLD_PX = 8;

interface LocalColumn {
	readonly key: string;
	readonly label: string;
	readonly align: 'left' | 'right' | 'center';
	/** Null leaves the width binding unset, so the column stretches to fill remaining space. */
	readonly width: number | null;
	readonly minWidth: number;
}

const COLUMNS: readonly LocalColumn[] = [
	{ key: 'number', label: '#', align: 'right', width: 44, minWidth: 44 },
	{ key: 'type', label: 'Type', align: 'left', width: 104, minWidth: 104 },
	{ key: 'first', label: 'White / Title', align: 'left', width: null, minWidth: 170 },
	{ key: 'firstElo', label: 'Elo White', align: 'right', width: 96, minWidth: 96 },
	{ key: 'result', label: 'Result', align: 'center', width: 64, minWidth: 64 },
	{ key: 'second', label: 'Black / Author', align: 'left', width: null, minWidth: 170 },
	{ key: 'secondElo', label: 'Elo Black', align: 'right', width: 96, minWidth: 96 },
	{ key: 'annotator', label: 'Annotator', align: 'left', width: null, minWidth: 150 },
	{ key: 'eco', label: 'ECO', align: 'left', width: 58, minWidth: 58 },
	{ key: 'moves', label: 'Moves', align: 'right', width: 66, minWidth: 66 },
	{ key: 'date', label: 'Date', align: 'right', width: 92, minWidth: 92 },
	{ key: 'event', label: 'Event', align: 'left', width: null, minWidth: 180 },
];

interface LocalRow {
	readonly entry: LocalFolderEntry;
	readonly isDocument: boolean;
	readonly badge: string;
	readonly number: string;
	readonly first: string;
	readonly firstElo: string;
	readonly result: string;
	readonly second: string;
	readonly secondElo: string;
	readonly annotator: string;
	readonly eco: string;
	readonly moves: string;
	readonly date: string;
	readonly event: string;
}

interface EntryDraft {
	readonly itemType: ItemType;
	readonly title: string;
	readonly pgn: string;
	readonly fen: string;
}

@Component({
	selector: 'app-local-collection-view',
	standalone: true,
	imports: [DecimalPipe, RouterLink, PreviewBoardComponent, CollectionIconComponent],
	templateUrl: './local-collection-view.component.html',
	styleUrl: './collection-view.component.scss',
	host: {
		'(document:keydown)': 'onShortcut($event)',
		'(document:click)': 'closeMenu()',
		'(document:contextmenu)': 'closeMenu()',
		'(window:blur)': 'closeMenu()',
		'(document:keydown.escape)': 'closeMenu()',
	},
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalCollectionViewComponent {
	private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
	private readonly shelf = inject(LocalShelfService);
	private readonly sync = inject(LocalSyncService);
	private readonly clipboard = inject(ClipboardStore);
	private readonly api = inject(CollectionApiService);
	private readonly confirmDialog = inject(ConfirmService);
	private readonly notify = inject(NotificationService);
	private readonly tabs = inject(TabsStore);
	readonly bridge = inject(AgentBridgeService);
	readonly auth = inject(AuthService);

	readonly kind = input.required<CollectionKind>();
	readonly id = input.required<string>();

	readonly collection = signal<LocalFolderCollection | null>(null);
	readonly entries = signal<readonly LocalFolderEntry[]>([]);
	readonly loading = signal(false);
	readonly busy = signal(false);
	readonly pushing = signal(false);

	readonly selectedId = signal<string | null>(null);
	readonly preview = signal<LocalFolderEntryDetail | null>(null);
	readonly menu = signal<{ x: number; y: number; entry: LocalFolderEntry } | null>(null);
	readonly draft = signal<EntryDraft | null>(null);
	readonly saving = signal(false);

	readonly availableTypes = computed<readonly ItemType[]>(() => ITEM_TYPES_BY_KIND[this.kind()]);

	readonly backLink = computed(() => (this.kind() === 'REPERTOIRE' ? '/repertoire' : '/library'));
	readonly title = computed(() => this.collection()?.name ?? '');

	readonly missing = computed(() => !this.loading() && this.collection() === null);

	readonly selected = computed(() => this.entries().find((entry) => entry.id === this.selectedId()) ?? null);

	readonly columns = COLUMNS;

	readonly tableMinWidth = COLUMNS.reduce((total, column) => total + column.minWidth, 0);

	readonly rows = computed<readonly LocalRow[]>(() =>
		this.entries().map((entry, index) => ({
			entry,
			isDocument: entry.shape === 'DOCUMENT',
			badge: this.label(entry.itemType),
			first: entry.shape === 'GAME' ? (entry.white ?? '') : (entry.title ?? ''),
			firstElo: entry.whiteElo === null ? '' : String(entry.whiteElo),
			result: entry.result ?? '',
			second: entry.shape === 'GAME' ? (entry.black ?? '') : (entry.author ?? ''),
			secondElo: entry.blackElo === null ? '' : String(entry.blackElo),
			annotator: entry.shape === 'GAME' ? (entry.author ?? '') : '',
			eco: entry.eco ?? '',
			moves: entry.plyCount ? String(Math.round(entry.plyCount / 2)) : '',
			date: entry.date ?? (entry.year ? String(entry.year) : ''),
			event: entry.event ?? '',
			number: String(index + 1),
		})),
	);

	readonly viewport = inject(ViewportService);

	readonly previewWidth = signal(DEFAULT_PREVIEW_PX);
	readonly resizing = signal(false);

	readonly sheetOffset = signal(0);
	private sheetDragFrom: number | null = null;
	private sheetPointerId: number | null = null;
	private sheetStartedAt = 0;

	readonly sheetDragging = signal(false);

	readonly sheetEntering = signal(false);

	readonly handleOffset = signal<number | null>(null);
	readonly handleActive = signal(false);

	readonly listGutterRight = computed(() => (this.preview() ? this.previewWidth() + LIST_GUTTER_PX : LIST_GUTTER_PX));

	private readonly selectedIndex = computed(() => {
		const id = this.selectedId();
		return id === null ? -1 : this.entries().findIndex((entry) => entry.id === id);
	});

	readonly hasPreviousItem = computed(() => this.selectedIndex() > 0);

	readonly hasNextItem = computed(() => {
		const at = this.selectedIndex();
		return at !== -1 && at < this.entries().length - 1;
	});

	readonly selectedRow = computed(() => this.rows().find((row) => row.entry.id === this.selectedId()) ?? null);

	startResize(event: PointerEvent): void {
		event.preventDefault();
		this.resizing.set(true);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onResize(event: PointerEvent, body: HTMLElement): void {
		if (!this.resizing()) {
			return;
		}
		const rect = body.getBoundingClientRect();
		const width = rect.right - event.clientX;
		this.previewWidth.set(Math.min(Math.max(width, MIN_PREVIEW_PX), Math.max(rect.width / 2, MIN_PREVIEW_PX)));
	}

	stopResize(): void {
		this.resizing.set(false);
	}

	onHandlePointerDown(event: PointerEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.handleActive.set(true);
		this.resizing.set(true);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onHandleDrag(event: PointerEvent, body: HTMLElement): void {
		if (!this.handleActive()) {
			return;
		}
		this.onResize(event, body);

		const rect = body.getBoundingClientRect();
		const y = event.clientY - rect.top;
		this.handleOffset.set(
			Math.min(Math.max(y, HANDLE_MARGIN_PX), Math.max(rect.height - HANDLE_MARGIN_PX, HANDLE_MARGIN_PX)),
		);
	}

	onHandlePointerUp(): void {
		this.handleActive.set(false);
		this.resizing.set(false);
	}

	private resetSheet(): void {
		this.sheetDragFrom = null;
		this.sheetPointerId = null;
		this.sheetDragging.set(false);
		this.sheetOffset.set(0);
	}

	onSheetPointerDown(event: PointerEvent): void {
		if (!this.viewport.isMobile()) return;
		this.sheetDragFrom = event.clientY;
		this.sheetPointerId = event.pointerId;
		this.sheetStartedAt = event.timeStamp;
		this.sheetOffset.set(0);
	}

	onSheetPointerMove(event: PointerEvent): void {
		if (this.sheetDragFrom === null || event.pointerId !== this.sheetPointerId) return;

		// No pointerup arrived (e.g. released outside the window); end the drag here.
		if (event.pointerType === 'mouse' && event.buttons === 0) {
			this.onSheetPointerUp();
			return;
		}

		const travelled = event.clientY - this.sheetDragFrom;

		if (!this.sheetDragging()) {
			if (travelled < DRAG_THRESHOLD_PX) {
				return;
			}
			this.sheetDragging.set(true);
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		}

		this.sheetOffset.set(Math.max(0, travelled));
	}

	onSheetPointerUp(event?: PointerEvent): void {
		if (this.sheetDragFrom === null) return;

		const dragged = this.sheetDragging();
		const travelled = this.sheetOffset();
		const elapsed = event ? Math.max(1, event.timeStamp - this.sheetStartedAt) : 1;

		this.sheetDragFrom = null;
		this.sheetPointerId = null;
		this.sheetDragging.set(false);

		if (!dragged) {
			return;
		}

		if (travelled > window.innerHeight / 4 || (travelled / elapsed > 0.5 && travelled > 40)) {
			this.closePreview();
			return;
		}
		this.sheetOffset.set(0);
	}

	openSelected(): void {
		const entry = this.selected();
		if (entry) {
			this.open(entry);
		}
	}

	constructor() {
		effect(() => {
			const kind = this.kind();
			const id = this.id();
			void this.load(kind, id);
		});

		effect(() => {
			this.tabs.describe(this.collection()?.name ?? null);
		});
	}

	private async load(kind: CollectionKind, id: string): Promise<void> {
		this.loading.set(true);
		try {
			const [collection, entries] = await Promise.all([this.shelf.collection(kind, id), this.shelf.entries(id)]);
			this.collection.set(collection);
			this.entries.set(entries);
			this.reselect(entries);
		} finally {
			this.loading.set(false);
		}
	}

	private reselect(entries: readonly LocalFolderEntry[]): void {
		const current = this.selectedId();
		if (current !== null && entries.some((entry) => entry.id === current)) {
			void this.showPreview(current);
			return;
		}
		this.selectedId.set(null);
		this.preview.set(null);
	}

	select(entry: LocalFolderEntry): void {
		const opening = this.preview() === null;
		this.resetSheet();
		this.selectedId.set(entry.id);
		void this.showPreview(entry.id, opening);
	}

	private async showPreview(id: string, opening = false): Promise<void> {
		try {
			const detail = await this.shelf.entry(id);
			if (opening && detail) {
				this.sheetEntering.set(true);
				setTimeout(() => this.sheetEntering.set(false), SHEET_ENTER_MS);
			}
			this.preview.set(detail);
		} catch {
			this.preview.set(null);
		}
	}

	closePreview(): void {
		this.selectedId.set(null);
		this.preview.set(null);
		this.resetSheet();
	}

	selectPrevious(): void {
		this.step(-1);
	}

	selectNext(): void {
		this.step(1);
	}

	private step(by: number): void {
		const entries = this.entries();
		const at = entries.findIndex((entry) => entry.id === this.selectedId());
		const next = entries[at + by];
		if (at >= 0 && next) {
			this.select(next);
			this.scrollRowIntoView(next.id);
		}
	}

	private scrollRowIntoView(id: string): void {
		const row = this.host.nativeElement.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
		if (!row) {
			return;
		}
		const container = scrollableAncestor(row);
		if (container) {
			scrollIntoContainer(container, row, { block: 'nearest', margin: ROW_CLEARANCE_PX });
		}
	}

	open(entry: LocalFolderEntry): void {
		this.tabs.openElsewhere(`/analysis?local=${encodeURIComponent(entry.id)}`);
	}

	openMenu(event: MouseEvent, entry: LocalFolderEntry): void {
		event.preventDefault();
		event.stopPropagation();
		const at = fitOnScreen(event.clientX, event.clientY, MENU_FOOTPRINT);
		this.menu.set({ x: at.x, y: at.y, entry });
	}

	closeMenu(): void {
		this.menu.set(null);
	}

	openFromMenu(entry: LocalFolderEntry): void {
		this.closeMenu();
		this.open(entry);
	}

	onImportFile(event: Event): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) {
			return;
		}

		this.busy.set(true);
		file
			.text()
			.then((pgn) => this.shelf.append(this.id(), pgn))
			.then((result) => {
				this.notify.info(`${result.added} ${result.added === 1 ? 'game' : 'games'} added.`);
				return this.load(this.kind(), this.id());
			})
			.catch((error: Error) => this.notify.error(error.message))
			.finally(() => this.busy.set(false));
	}

	exportCollection(): void {
		void this.shelf
			.read(this.id())
			.then((pgn) => {
				if (pgn === null) {
					throw new Error('That file is no longer in the folder');
				}
				saveBlob(new Blob([pgn], { type: 'application/x-chess-pgn' }), `${this.title()}.pgn`);
			})
			.catch((error: Error) => this.notify.error(error.message));
	}

	onShortcut(event: KeyboardEvent): void {
		const target = event.target as HTMLElement | null;
		if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
			return;
		}
		if (!(event.ctrlKey || event.metaKey)) {
			return;
		}
		const key = event.key.toLowerCase();
		if (key === 'c' && this.selected()) {
			void this.copySelection(true);
		} else if (key === 'x' && this.selected()) {
			void this.copySelection(false);
		} else if (key === 'v' && this.canPaste()) {
			void this.paste();
		}
	}

	readonly pending = computed(() => this.clipboard.contents());
	readonly canPaste = computed(() => this.pending()?.scope === 'ITEMS');

	async copySelection(copy: boolean): Promise<void> {
		const entry = this.selected();
		if (!entry || this.busy()) {
			return;
		}

		this.busy.set(true);
		try {
			const detail = await this.shelf.entry(entry.id);
			if (!detail) {
				this.notify.error('That entry is no longer in the file.');
				return;
			}
			this.clipboard.putGames(detail.pgn, copy, '1', {
				collectionId: this.id(),
				entryIds: [entry.id],
			});
			this.notify.info(`1 entry ${copy ? 'copied' : 'cut'}. Open another collection and paste.`);
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.busy.set(false);
		}
	}

	async paste(): Promise<void> {
		const contents = this.clipboard.take('ITEMS');
		if (!contents || this.busy()) {
			return;
		}

		this.busy.set(true);
		try {
			const pgn = contents.pgn ?? (await this.pgnOf(contents.ids));
			if (pgn.trim().length === 0) {
				return;
			}
			await this.shelf.append(this.id(), pgn, {});

			// Removes the source entries only after the append succeeds, so a failure loses nothing.
			if (!contents.copy && contents.from && contents.from.collectionId !== this.id()) {
				const failed: string[] = [];
				for (const entryId of contents.from.entryIds) {
					try {
						await this.shelf.removeEntry(entryId);
					} catch {
						failed.push(entryId);
					}
				}
				if (failed.length > 0) {
					this.notify.error(
						`${failed.length} of ${contents.from.entryIds.length} ${failed.length === 1 ? 'entry' : 'entries'} pasted here ` +
							`could not be removed from the original collection, and now exist in both.`,
					);
				}
			}
			this.clipboard.consumed();
			await this.load(this.kind(), this.id());
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.busy.set(false);
		}
	}

	private async pgnOf(ids: readonly number[]): Promise<string> {
		if (ids.length === 0) {
			return '';
		}
		const details = await Promise.all(ids.map((id) => firstValueFrom(this.api.getItem(id))));
		return details
			.map((item) => item.pgn?.trim() ?? '')
			.filter((text) => text.length > 0)
			.join('\n\n');
	}

	async removeEntry(entry: LocalFolderEntry): Promise<void> {
		this.closeMenu();
		const confirmed = await this.confirmDialog.ask(`Remove "${this.rowName(entry)}" from this file?`, {
			confirmLabel: 'Remove',
			danger: true,
		});
		if (!confirmed) {
			return;
		}

		this.busy.set(true);
		try {
			await this.shelf.removeEntry(entry.id);
			this.closePreview();
			await this.load(this.kind(), this.id());
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.busy.set(false);
		}
	}

	pushToCloud(file: LocalFolderCollection): void {
		if (this.pushing() || file.cloudId !== null) {
			return;
		}
		if (!this.auth.isLoggedIn()) {
			this.notify.error('Sign in to copy a collection to the cloud.');
			return;
		}

		this.pushing.set(true);
		this.sync
			.push(file)
			.then(() => this.load(this.kind(), this.id()))
			.catch((error: Error) =>
				this.notify.error(isOffline(error) ? 'No internet connection. Cannot push to cloud.' : error.message),
			)
			.finally(() => this.pushing.set(false));
	}

	startDraft(): void {
		this.closeMenu();
		this.draft.set({ itemType: this.availableTypes()[0], title: '', pgn: '', fen: '' });
	}

	closeDraft(): void {
		this.draft.set(null);
	}

	chooseType(itemType: ItemType): void {
		this.draft.update((current) => (current ? { ...current, itemType } : current));
	}

	onDraftTitle(event: Event): void {
		const title = (event.target as HTMLInputElement).value;
		this.draft.update((current) => (current ? { ...current, title } : current));
	}

	onDraftPgn(event: Event): void {
		const pgn = (event.target as HTMLTextAreaElement).value;
		this.draft.update((current) => (current ? { ...current, pgn } : current));
	}

	onDraftFen(event: Event): void {
		const fen = (event.target as HTMLInputElement).value;
		this.draft.update((current) => (current ? { ...current, fen } : current));
	}

	isDocumentType(itemType: ItemType): boolean {
		return itemType === 'ANALYSIS' || itemType === 'STUDY' || itemType === 'MAIN_LINE';
	}

	isFenType(itemType: ItemType): boolean {
		return itemType === 'STUDY' || itemType === 'ANALYSIS';
	}

	saveDraft(event: Event): void {
		event.preventDefault();

		const draft = this.draft();
		if (!draft || this.saving()) {
			return;
		}

		const typed = draft.pgn.trim();
		const fen = draft.fen.trim();
		const title = draft.title.trim();
		let pgn: string;

		if (typed.length > 0) {
			pgn = typed;
		} else if (this.isFenType(draft.itemType) && fen.length > 0) {
			if (!isLoadableFen(fen)) {
				this.notify.error('That is not a valid position.');
				return;
			}
			pgn = `[Event "${title || '?'}"]\n[Result "*"]\n[SetUp "1"]\n[FEN "${fen}"]\n\n*\n`;
		} else {
			pgn = `[Event "${title || '?'}"]\n[Result "*"]\n\n*\n`;
		}

		this.saving.set(true);
		this.shelf
			.append(this.id(), pgn, { itemType: draft.itemType, title: title || undefined })
			.then(() => {
				this.draft.set(null);
				return this.load(this.kind(), this.id());
			})
			.catch((error: Error) => this.notify.error(error.message))
			.finally(() => this.saving.set(false));
	}

	labelFor(itemType: ItemType): string {
		return ITEM_TYPE_LABEL[itemType];
	}

	label(itemType: string): string {
		return ITEM_TYPE_LABEL[itemType as ItemType] ?? itemType.toLowerCase();
	}

	rowName(entry: LocalFolderEntry): string {
		return entry.shape === 'GAME' ? `${entry.white ?? '?'} — ${entry.black ?? '?'}` : (entry.title ?? 'Untitled');
	}

	itemTypeOf(entry: LocalFolderEntry | null): ItemType | null {
		return entry ? ((entry.itemType as ItemType) ?? null) : null;
	}
}
