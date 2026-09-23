import {
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	computed,
	effect,
	inject,
	input,
	signal,
	untracked,
} from '@angular/core';
import { isLoadableFen } from '../../core/chess/fen.util';
import { NO_GAME_HEADERS } from '../../core/chess/game-headers';
import { gameLabel } from '../../core/chess/game-label';
import { composePgnFile } from '../../core/chess/pgn-file';
import { saveBlob } from '../../core/browser/download';
import { AuthService } from '../../core/services/auth.service';
import { SignedOutNoticeComponent } from '../../shared/signed-out/signed-out-notice.component';
import { ClipboardStore } from '../../core/services/clipboard.store';
import { CollectionApiService } from '../../core/services/collection-api.service';
import { TabsStore } from '../../core/tabs/tabs.store';
import { ConfirmService } from '../../core/services/confirm.service';
import { NotificationService } from '../../core/services/notification.service';
import { CloudStorageService } from '../../core/services/cloud-storage.service';
import { AgentBridgeService } from '../../core/agent/agent-bridge.service';
import { LocalShelfService } from '../../core/agent/local-shelf.service';
import { LocalSyncService } from '../../core/agent/local-sync.service';
import { LocalFolderCollection } from '../../core/agent/agent.models';
import {
	CollectionKind,
	CollectionSummary,
	ITEM_TYPES_BY_KIND,
	ITEM_TYPE_LABEL,
	ImportResult,
	ItemDetail,
	ItemSortKey,
	ItemSummary,
	ItemType,
	TYPE_SORT_KEYS,
	TYPE_SORT_STATES,
} from '../../core/models/collection.model';
import { TooltipDirective } from '../../shared/tooltip/tooltip.directive';
import { CollectionIconComponent } from './collection-icon.component';
import { PreviewBoardComponent } from './preview-board/preview-board.component';
import { ViewportService } from '../../core/layout/viewport.service';
import { fitOnScreen } from '../../core/browser/menu-placement';

interface ColumnDefinition {
	readonly key: string;
	readonly label: string;
	readonly sort: ItemSortKey | null;
	readonly align: 'left' | 'right' | 'center';
	readonly width: number | null;
	readonly minWidth: number;
	readonly cell: string;
	readonly pinned?: boolean;
}

interface RenderedCell {
	readonly key: string;
	readonly classes: string;
	readonly colspan: number | null;
	readonly text: string;
}

interface RenderedItem {
	readonly id: number;
	readonly itemType: ItemType;
	readonly badge: string;
	readonly number: number;
	readonly isDocument: boolean;
	readonly cells: readonly RenderedCell[];

	readonly first: string;
	readonly result: string;
	readonly second: string;
}

interface EntryDraft {
	readonly itemType: ItemType;
	readonly title: string;
	readonly pgn: string;
	readonly fen: string;
}

// A blank document, so a new analysis is a valid PGN from the moment it exists.
const EMPTY_PGN = '[Event "?"]\n[Result "*"]\n\n*';

const MIN_PREVIEW_PX = 300;

const DEFAULT_PREVIEW_PX = 380;

const HANDLE_MARGIN_PX = 24;

const LIST_GUTTER_PX = 20;

// Game rows and document rows share these columns by merging pairs of them (see MERGE_INTO).
const COLUMNS: readonly ColumnDefinition[] = [
	{ key: 'number', label: '#', sort: 'MANUAL', align: 'right', width: 44, minWidth: 44, cell: 'number', pinned: true },
	{ key: 'type', label: 'Type', sort: 'TYPE', align: 'left', width: 104, minWidth: 104, cell: 'type' },
	{ key: 'first', label: 'White / Title', sort: 'WHITE', align: 'left', width: null, minWidth: 170, cell: 'name' },
	{ key: 'firstElo', label: 'Elo White', sort: 'WHITE_ELO', align: 'right', width: 96, minWidth: 96, cell: 'elo' },
	{ key: 'result', label: 'Result', sort: 'RESULT', align: 'center', width: 64, minWidth: 64, cell: 'result' },
	{ key: 'second', label: 'Black / Author', sort: 'BLACK', align: 'left', width: null, minWidth: 170, cell: 'name' },
	{ key: 'secondElo', label: 'Elo Black', sort: 'BLACK_ELO', align: 'right', width: 96, minWidth: 96, cell: 'elo' },
	{ key: 'annotator', label: 'Annotator', sort: 'ANNOTATOR', align: 'left', width: null, minWidth: 150, cell: 'name' },
	{ key: 'eco', label: 'ECO', sort: 'ECO', align: 'left', width: 58, minWidth: 58, cell: 'eco' },
	{ key: 'moves', label: 'Moves', sort: 'MOVES', align: 'right', width: 66, minWidth: 66, cell: 'moves' },
	{ key: 'date', label: 'Date', sort: 'DATE', align: 'right', width: 92, minWidth: 92, cell: 'date' },
	{ key: 'changed', label: 'Changed', sort: 'UPDATED', align: 'right', width: 96, minWidth: 96, cell: 'date' },
	{ key: 'event', label: 'Event', sort: 'EVENT', align: 'left', width: null, minWidth: 180, cell: 'event' },
];

const MERGE_INTO: Readonly<Record<string, string>> = { first: 'firstElo', second: 'secondElo' };

const COLUMN_ORDER_KEY = 'premovedprep.collections.columnOrder';

const UNKNOWN_NAME = '?';

const UNKNOWN_DATE = '????.??.??';

const UNKNOWN_RESULT = '*';

const UNTITLED = 'Untitled';

const MENU_FOOTPRINT = { width: 208, height: 132 };

// Mirrors the preview-sheet-up keyframes duration in the stylesheet.
const SHEET_ENTER_MS = 240;

const DRAG_THRESHOLD_PX = 8;

// One decimal, no trailing '.0' - '2 MB', not '2.0 MB'.
function megabytes(bytes: number): string {
	return String(Math.round((bytes / (1024 * 1024)) * 10) / 10);
}

@Component({
	selector: 'app-collection-view',
	standalone: true,
	imports: [CollectionIconComponent, PreviewBoardComponent, TooltipDirective, SignedOutNoticeComponent],
	templateUrl: './collection-view.component.html',
	styleUrl: './collection-view.component.scss',
	host: {
		'(document:click)': 'onDocumentClick($event)',
		'(document:keydown.escape)': 'onEscape()',
		// Ctrl+A / Ctrl+C / Ctrl+X / Ctrl+V / Delete, bound on the document.
		'(document:keydown)': 'onShortcut($event)',
	},
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CollectionViewComponent {
	private readonly api = inject(CollectionApiService);
	private readonly notify = inject(NotificationService);
	private readonly cloud = inject(CloudStorageService);
	private readonly confirmDialog = inject(ConfirmService);
	private readonly clipboard = inject(ClipboardStore);
	readonly auth = inject(AuthService);
	readonly viewport = inject(ViewportService);
	private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

	readonly id = input.required<string>();
	readonly kind = input.required<CollectionKind>();

	readonly collection = signal<CollectionSummary | null>(null);
	readonly items = signal<readonly ItemSummary[]>([]);
	readonly loading = signal(false);
	readonly error = signal<string | null>(null);

	readonly sort = signal<ItemSortKey>('MANUAL');
	readonly ascending = signal<boolean | undefined>(undefined);

	readonly selected = signal<ItemDetail | null>(null);
	readonly menu = signal<{ x: number; y: number; item: RenderedItem } | null>(null);
	readonly draft = signal<EntryDraft | null>(null);
	readonly saving = signal(false);

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

	readonly columnOrder = signal<readonly string[]>(storedColumnOrder() ?? COLUMNS.map((column) => column.key));

	readonly columns = computed<readonly ColumnDefinition[]>(() =>
		this.columnOrder()
			.map((key) => COLUMNS.find((column) => column.key === key))
			.filter((column): column is ColumnDefinition => column !== undefined),
	);

	readonly columnDragIndex = signal<number | null>(null);
	readonly columnDropIndex = signal<number | null>(null);

	private readonly firstMovableIndex = computed(() => {
		const columns = this.columns();
		let index = 0;
		while (columns[index]?.pinned) {
			index++;
		}
		return index;
	});

	readonly tableMinWidth = COLUMNS.reduce((total, column) => total + column.minWidth, 0);

	readonly availableTypes = computed(() => ITEM_TYPES_BY_KIND[this.kind()]);
	readonly isEmpty = computed(() => !this.loading() && this.items().length === 0);

	readonly rows = computed<readonly RenderedItem[]>(() => {
		const items = this.items();
		const numbers = manualPositions(items);
		const columns = this.columns();
		const merges = this.mergesDocumentColumns();

		return items.map((item) => render(item, numbers.get(item.id) ?? 0, columns, merges));
	});

	readonly lastIndex = computed(() => this.rows().length - 1);

	readonly canReorder = computed(() => this.sort() === 'MANUAL');

	readonly mergesDocumentColumns = computed(() => this.kind() === 'REPERTOIRE');

	readonly dragIndex = signal<number | null>(null);
	readonly dropIndex = signal<number | null>(null);

	readonly typeSortStates = computed<readonly ItemSortKey[]>(() => {
		const present = new Set(this.items().map((item) => item.itemType));
		const seen: string[] = [];
		const states: ItemSortKey[] = [];

		for (const key of TYPE_SORT_KEYS) {
			const signature = typeSequence(key, present).join(',');
			if (signature.length === 0 || seen.includes(signature)) {
				continue;
			}
			seen.push(signature);
			states.push(key);
		}
		return states.length > 0 ? states : ['TYPE'];
	});

	readonly typeOrderHint = computed(() => {
		const present = new Set(this.items().map((item) => item.itemType));
		const active = this.sort();
		const states = this.typeSortStates();
		const key = isTypeSort(active) && states.includes(active) ? active : (states[0] ?? 'TYPE');

		const order = typeSequence(key, present)
			.map((type) => ITEM_TYPE_LABEL[type])
			.join(', ');
		const more = states.length > 1 ? ' (click to change the order)' : '';

		return order.length > 0 ? `Sort by type: ${order}${more}` : 'Sort by type';
	});

	readonly selectedId = computed(() => this.selected()?.id ?? null);

	readonly selectedRow = computed(() => {
		const id = this.selectedId();
		return id === null ? null : (this.rows().find((row) => row.id === id) ?? null);
	});

	private readonly selectedIndex = computed(() => {
		const id = this.selectedId();
		return id === null ? -1 : this.rows().findIndex((row) => row.id === id);
	});

	readonly hasPreviousItem = computed(() => this.selectedIndex() > 0);

	readonly hasNextItem = computed(() => {
		const at = this.selectedIndex();
		return at !== -1 && at < this.rows().length - 1;
	});

	readonly listGutterRight = computed(() => (this.selected() ? this.previewWidth() + LIST_GUTTER_PX : LIST_GUTTER_PX));

	readonly picked = signal<ReadonlySet<number>>(new Set());

	readonly actionIds = computed<readonly number[]>(() => {
		const chosen = this.picked();
		if (chosen.size > 0) {
			return this.rows()
				.map((row) => row.id)
				.filter((id) => chosen.has(id));
		}
		const id = this.selectedId();
		return id === null ? [] : [id];
	});

	readonly actionCount = computed(() => this.actionIds().length);

	readonly countSuffix = computed(() => (this.actionCount() > 1 ? ` (${this.actionCount()})` : ''));

	readonly pasteSuffix = computed(() => {
		const size = this.pending()?.ids.length ?? 0;
		return size > 1 ? ` (${size})` : '';
	});

	readonly pending = computed(() => this.clipboard.contents());
	readonly canPaste = computed(() => this.pending()?.scope === 'ITEMS');

	private readonly tabs = inject(TabsStore);
	readonly bridge = inject(AgentBridgeService);
	private readonly shelf = inject(LocalShelfService);
	private readonly sync = inject(LocalSyncService);

	// The pairing is recorded beside the local file, not in the cloud, so it is found by asking
	// the shelf which of its files says it mirrors this collection.
	readonly localTwin = signal<LocalFolderCollection | null>(null);

	readonly pulling = signal(false);

	private async readLocalTwin(): Promise<void> {
		const folder = this.collection();
		if (!this.bridge.embedded() || !folder) {
			this.localTwin.set(null);
			return;
		}
		try {
			const files = await this.shelf.shelf(folder.kind, folder.color);
			this.localTwin.set(files.find((file) => file.cloudId === folder.id) ?? null);
		} catch {
			this.localTwin.set(null);
		}
	}

	// Copies this collection down to the folder on this computer; never removes the cloud one.
	async pullToComputer(): Promise<void> {
		const folder = this.collection();
		if (!folder || this.localTwin() !== null || this.pulling()) {
			return;
		}
		this.pulling.set(true);
		try {
			await this.sync.pull(folder);
			await this.readLocalTwin();
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.pulling.set(false);
		}
	}

	constructor() {
		effect(() => {
			this.collection();
			untracked(() => void this.readLocalTwin());
		});

		// The tab carries the collection's name; the icon is what still says which section it is in.
		effect(() => {
			this.tabs.describe(this.collection()?.name ?? null);
		});

		effect(() => {
			const id = Number(this.id());
			const sort = this.sort();
			const ascending = this.ascending();
			if (!this.auth.isLoggedIn()) return;
			this.load(id, sort, ascending);
		});
	}

	private loadRequestId = 0;

	private load(id: number, sort: ItemSortKey, ascending: boolean | undefined): void {
		this.loading.set(true);
		this.error.set(null);

		// Guards against an older request's response landing after a newer load.
		const request = ++this.loadRequestId;

		this.api.get(id).subscribe({
			next: (collection) => {
				if (request !== this.loadRequestId) return;
				this.collection.set(collection);
			},
			error: (err: Error) => {
				if (request !== this.loadRequestId) return;
				this.error.set(err.message);
			},
		});

		this.api.listItems(id, sort, ascending).subscribe({
			next: (items) => {
				if (request !== this.loadRequestId) return;
				this.items.set(items);
				this.loading.set(false);
			},
			error: (err: Error) => {
				if (request !== this.loadRequestId) return;
				this.error.set(err.message);
				this.loading.set(false);
			},
		});
	}

	private reload(): void {
		this.load(Number(this.id()), this.sort(), this.ascending());
	}

	retry(): void {
		this.reload();
	}

	// First click uses the column's natural direction, which the server decides.
	sortBy(key: ItemSortKey | null): void {
		if (key === null) {
			return;
		}
		if (key === 'MANUAL') {
			this.setSort('MANUAL');
			return;
		}
		if (isTypeSort(key)) {
			this.setSort(this.nextTypeSort());
			return;
		}
		if (this.sort() === key) {
			this.ascending.update((current) => !(current ?? true));
			return;
		}
		this.setSort(key);
	}

	private setSort(key: ItemSortKey): void {
		this.sort.set(key);
		this.ascending.set(undefined);
	}

	private nextTypeSort(): ItemSortKey {
		const cycle = this.typeSortStates();
		const current = cycle.indexOf(this.sort());
		return cycle[(current + 1) % cycle.length] ?? 'TYPE';
	}

	private isActiveColumn(key: ItemSortKey): boolean {
		const active = this.sort();
		return isTypeSort(key) ? isTypeSort(active) : active === key;
	}

	ariaSort(key: ItemSortKey | null): 'ascending' | 'descending' | 'other' | null {
		if (key === null || !this.isActiveColumn(key)) {
			return null;
		}
		if (key === 'MANUAL' || isTypeSort(key)) {
			return 'other';
		}
		const ascending = this.ascending();
		if (ascending === undefined) {
			return 'other';
		}
		return ascending ? 'ascending' : 'descending';
	}

	headerHint(key: string): string | null {
		return key === 'type' ? this.typeOrderHint() : null;
	}

	private selectRequestId = 0;

	select(row: RenderedItem): void {
		if (this.selectedId() === row.id) {
			return;
		}

		// Set when the detail arrives: the sheet element does not exist before the fetch.
		const opening = this.selected() === null;

		this.resetSheet();

		// Guards against an older request's response landing after a newer selection. The previous
		// game stays on the board until the next one arrives; clearing it first would show an empty
		// board for the length of the request.
		const request = ++this.selectRequestId;

		this.api.getItem(row.id).subscribe({
			next: (detail) => {
				if (request !== this.selectRequestId) return;
				if (opening) {
					this.sheetEntering.set(true);
					setTimeout(() => this.sheetEntering.set(false), SHEET_ENTER_MS);
				}
				this.selected.set(detail);
			},
			error: (err: Error) => {
				if (request !== this.selectRequestId) return;
				this.notify.error(err.message);
			},
		});
	}

	onRowClick(event: MouseEvent, row: RenderedItem): void {
		this.clipboard.clear();

		if (this.viewport.isMobile()) {
			this.select(row);
			return;
		}

		if (event.ctrlKey || event.metaKey) {
			event.preventDefault();
			this.togglePicked(row.id);
			return;
		}
		this.picked.set(new Set());
		this.select(row);
	}

	isPicked(id: number): boolean {
		return this.picked().has(id) || (this.picked().size === 0 && this.selectedId() === id);
	}

	private togglePicked(id: number): void {
		this.picked.update((current) => {
			const next = new Set(current);
			if (next.size === 0 && this.selectedId() !== null) {
				next.add(this.selectedId() as number);
			}
			if (!next.delete(id)) {
				next.add(id);
			}
			return next;
		});
	}

	selectAll(): void {
		this.clipboard.clear();
		this.picked.set(new Set(this.rows().map((row) => row.id)));
	}

	clearPicked(): void {
		this.picked.set(new Set());
	}

	onShortcut(event: KeyboardEvent): void {
		if (this.draft() || isTyping(event.target)) {
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
		if ((event.key === 'Delete' || event.key === 'Backspace') && this.actionCount() > 0) {
			event.preventDefault();
			void this.deleteSelected();
		}
	}

	copySelection(copy: boolean): void {
		const ids = this.actionIds();
		if (ids.length === 0) {
			return;
		}
		const label = ids.length === 1 ? '1 entry' : `${ids.length} entries`;
		this.clipboard.put('ITEMS', ids, copy, `${ids.length}`);
		this.notify.info(`${label} ${copy ? 'copied' : 'cut'}. Open another collection and paste.`);
	}

	paste(): void {
		const contents = this.clipboard.take('ITEMS');
		if (!contents) {
			return;
		}

		this.api.transferItems(Number(this.id()), contents.ids, contents.copy).subscribe({
			next: (moved) => {
				this.clipboard.consumed();
				this.picked.set(new Set(moved.map((item) => item.id)));
				this.closePreview();
				this.cloud.refresh();
				this.reload();
			},
			error: (err: Error) => {
				if (this.cloud.reportFull(err)) {
					return;
				}
				this.notify.error(err.message);
			},
		});
	}

	exportCollection(): void {
		const collection = this.collection();
		this.api.exportCollection(Number(this.id())).subscribe({
			next: (blob) => saveBlob(blob, `${fileName(collection?.name ?? 'collection')}.pgn`),
			error: (err: Error) => this.notify.error(err.message),
		});
	}

	closePreview(): void {
		this.selected.set(null);
		this.sheetDragFrom = null;
		this.sheetPointerId = null;
		this.sheetDragging.set(false);
		// Not reset while the sheet is being dismissed (see onSheetPointerUp); by the time this
		// runs the element is gone, so it must not be carried into the next sheet.
		this.sheetOffset.set(0);
	}

	// Nothing that opens or changes the sheet may inherit an offset from whatever happened before.
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

		// A press that ended somewhere this element never heard about. Stop rather than follow.
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

		// Downward only. Dragging up would lift the sheet off the top of the screen.
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

		// A quarter of the screen, or a flick: distance alone would let a short quick swipe do
		// nothing and spring back.
		if (travelled > window.innerHeight / 4 || (travelled / elapsed > 0.5 && travelled > 40)) {
			// Left where it is: the element is about to be removed, so snapping it back to the
			// top for one frame first would be exactly the jump this is meant to avoid.
			this.closePreview();
			return;
		}
		this.sheetOffset.set(0);
	}

	selectPrevious(): void {
		this.step(-1);
	}

	selectNext(): void {
		this.step(1);
	}

	private step(delta: number): void {
		const rows = this.rows();
		const id = this.selectedId();
		if (rows.length === 0 || id === null) {
			return;
		}

		const index = rows.findIndex((row) => row.id === id);
		const next = rows[index + delta];
		if (index === -1 || !next) {
			return;
		}

		this.select(next);
		this.scrollRowIntoView(next.id);
	}

	private scrollRowIntoView(id: number): void {
		const row = this.host.nativeElement.querySelector(`[data-item-id="${id}"]`);
		row?.scrollIntoView({ block: 'nearest' });
	}

	openItem(id: number): void {
		this.tabs.openElsewhere(`/analysis?item=${id}`);
	}

	onColumnDragStart(event: DragEvent, index: number): void {
		if (this.columns()[index]?.pinned) {
			event.preventDefault();
			return;
		}
		this.columnDragIndex.set(index);
		event.dataTransfer?.setData('text/plain', this.columns()[index]?.key ?? '');
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
		event.stopPropagation();
	}

	onColumnDragOver(event: DragEvent, index: number): void {
		if (this.columnDragIndex() === null) {
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}

		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const gap = event.clientX < box.left + box.width / 2 ? index : index + 1;
		this.columnDropIndex.set(Math.max(gap, this.firstMovableIndex()));
	}

	onColumnDragEnd(): void {
		this.columnDragIndex.set(null);
		this.columnDropIndex.set(null);
	}

	onColumnDrop(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();

		const from = this.columnDragIndex();
		const to = this.columnDropIndex();
		this.onColumnDragEnd();

		if (from !== null && to !== null) {
			this.moveColumn(from, to);
		}
	}

	private moveColumn(from: number, to: number): void {
		const order = [...this.columnOrder()];
		const moved = order[from];
		if (moved === undefined) {
			return;
		}

		// `to` is a gap, so lifting the column out shifts everything after it up by one.
		const target = Math.max(to > from ? to - 1 : to, this.firstMovableIndex());
		if (target === from) {
			return;
		}

		order.splice(from, 1);
		order.splice(target, 0, moved);

		this.columnOrder.set(order);
		storeColumnOrder(order);
	}

	onDragStart(event: DragEvent, index: number): void {
		if (!this.canReorder()) {
			event.preventDefault();
			return;
		}
		this.dragIndex.set(index);
		const row = this.rows()[index];
		event.dataTransfer?.setData('text/plain', String(row?.id ?? ''));
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
	}

	onDragOver(event: DragEvent, index: number): void {
		if (this.dragIndex() === null) {
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}

		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		this.dropIndex.set(event.clientY < box.top + box.height / 2 ? index : index + 1);
	}

	onDragEnd(): void {
		this.dragIndex.set(null);
		this.dropIndex.set(null);
	}

	onDrop(event: DragEvent): void {
		event.preventDefault();
		const from = this.dragIndex();
		const to = this.dropIndex();
		this.onDragEnd();

		if (from !== null && to !== null) {
			this.moveRow(from, to);
		}
	}

	private moveRow(from: number, to: number): void {
		const current = this.items();
		const moved = current[from];
		if (!moved) {
			return;
		}

		const target = to > from ? to - 1 : to;
		if (target === from) {
			return;
		}

		const next = [...current];
		next.splice(from, 1);
		next.splice(target, 0, moved);

		const renumbered = next.map((item, index) => ({ ...item, sortOrder: index }));
		this.items.set(renumbered);

		this.api
			.reorderItems(
				Number(this.id()),
				renumbered.map((item) => item.id),
			)
			.subscribe({
				next: (items) => this.items.set(items),
				error: (err: Error) => {
					this.notify.error(err.message);
					this.reload();
				},
			});
	}

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

	openMenu(event: MouseEvent, item: RenderedItem): void {
		event.preventDefault();
		const at = fitOnScreen(event.clientX, event.clientY, MENU_FOOTPRINT);
		this.menu.set({ x: at.x, y: at.y, item });
	}

	closeMenu(): void {
		this.menu.set(null);
	}

	onDocumentClick(event: MouseEvent): void {
		this.closeMenu();

		const target = event.target as HTMLElement | null;
		if (!target || target.closest('tr, .collection-toolbar, .preview, .context-menu, .modal-backdrop')) {
			return;
		}
		this.clearPicked();
		this.closePreview();
	}

	onEscape(): void {
		if (this.menu()) {
			this.closeMenu();
			return;
		}
		if (this.draft()) {
			this.closeDraft();
			return;
		}
		if (this.picked().size > 0) {
			this.clearPicked();
			return;
		}
		this.closePreview();
	}

	labelFor(itemType: ItemType): string {
		return ITEM_TYPE_LABEL[itemType];
	}

	private describe(id: number): string {
		const item = this.items().find((entry) => entry.id === id);
		if (!item) {
			return 'this entry';
		}
		if (item.shape === 'DOCUMENT') {
			const title = item.title?.trim();
			return title ? `"${title}"` : 'this entry';
		}
		return `"${gameLabel(item)}"`;
	}

	async deleteSelected(): Promise<void> {
		const ids = this.actionIds();
		if (ids.length === 0) {
			return;
		}

		const what = ids.length === 1 ? this.describe(ids[0]) : `${ids.length} entries`;
		const confirmed = await this.confirmDialog.ask(`Delete ${what}? This cannot be undone.`, {
			confirmLabel: 'Delete',
			danger: true,
		});
		if (!confirmed) {
			return;
		}

		let remaining = ids.length;
		const done = () => {
			if (--remaining === 0) {
				this.clearPicked();
				this.closePreview();
				this.reload();
			}
		};

		for (const id of ids) {
			this.api.removeItem(id, Number(this.id())).subscribe({
				next: done,
				error: (err: Error) => {
					this.notify.error(err.message);
					done();
				},
			});
		}
	}

	startDraft(): void {
		this.closeMenu();
		this.draft.set({ itemType: this.availableTypes()[0], title: '', pgn: '', fen: '' });
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

	closeDraft(): void {
		this.draft.set(null);
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

		const pgnTyped = draft.pgn.trim();
		const fenTyped = draft.fen.trim();
		let pgn: string;
		// An ANALYSIS with a start FEN is stored as a STUDY.
		let itemType = draft.itemType;
		if (pgnTyped.length > 0) {
			pgn = pgnTyped;
		} else if (this.isFenType(draft.itemType) && fenTyped.length > 0) {
			if (!isLoadableFen(fenTyped)) {
				this.notify.error('That is not a valid position.');
				return;
			}
			pgn = composePgnFile({
				headers: NO_GAME_HEADERS,
				startFen: fenTyped,
				movetext: '',
				title: draft.title.trim() || undefined,
			});
			itemType = 'STUDY';
		} else {
			pgn = EMPTY_PGN;
		}

		this.saving.set(true);
		const title = draft.title.trim();

		this.api.createItem(Number(this.id()), itemType, pgn, title.length > 0 ? title : undefined).subscribe({
			next: () => {
				this.saving.set(false);
				this.draft.set(null);
				this.reload();
			},
			error: (err: Error) => {
				this.saving.set(false);
				if (this.cloud.reportFull(err)) {
					return;
				}
				this.notify.error(err.message);
			},
		});
	}

	onImportFile(event: Event): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		// Cleared so choosing the same file twice still fires `change`.
		input.value = '';
		if (!file) {
			return;
		}

		// The server refuses anything larger; checking here costs no upload. null means the
		// account's storage budget has not arrived yet, so the upload goes ahead regardless.
		const limit = this.cloud.maxRequestBytes();
		if (limit !== null && file.size > limit) {
			// Quotes the allowance, not the request cap: the allowance is what this is about.
			const quota = this.cloud.usage()?.bytesQuota ?? limit;
			this.notify.error(
				`That file is ${megabytes(file.size)} MB. Each user is allocated only ${megabytes(quota)} MB ` +
					`of cloud storage. Use the desktop agent to import it locally.`,
			);
			return;
		}

		const reader = new FileReader();
		reader.onload = () => {
			this.api.importPgn(Number(this.id()), String(reader.result)).subscribe({
				next: (result) => {
					this.reportImport(result);
					this.cloud.refresh();
					this.reload();
				},
				error: (err: Error) => {
					if (this.cloud.reportFull(err)) {
						return;
					}
					this.notify.error(err.message);
				},
			});
		};
		reader.onerror = () => this.notify.error('That file could not be read.');
		reader.readAsText(file);
	}

	private reportImport(result: ImportResult): void {
		const byType = new Map<ItemType, number>();
		for (const entry of result.items) {
			byType.set(entry.itemType, (byType.get(entry.itemType) ?? 0) + 1);
		}
		const breakdown = [...byType.entries()]
			.map(([type, count]) => `${count} ${count === 1 ? this.labelFor(type) : ITEM_TYPE_PLURAL[type]}`)
			.join(', ');

		const total = `${result.imported} entr${result.imported === 1 ? 'y' : 'ies'} imported`;
		const detail = breakdown.length > 0 ? ` — ${breakdown}` : '';

		if (result.skippedForSpace > 0) {
			const unreadable = result.skipped > 0 ? ` ${result.skipped} could not be read.` : '';
			this.notify.error(
				`${total}${detail}. ${result.skippedForSpace} left out — your cloud storage is full. ` +
					`Make room, or connect a computer with the Desktop agent, and import the file again to get the rest.` +
					unreadable,
			);
			return;
		}
		if (result.skipped > 0) {
			this.notify.error(`${total}${detail}. ${result.skipped} skipped — those games could not be read.`);
			return;
		}
		this.notify.info(`${total}${detail}.`);
	}
}

const ITEM_TYPE_PLURAL: Readonly<Record<ItemType, string>> = {
	ANALYSIS: 'analyses',
	STUDY: 'studies',
	GAME: 'games',
	MAIN_LINE: 'main-lines',
	MODEL_GAME: 'model-games',
};

function isTypeSort(key: ItemSortKey): boolean {
	return key === 'TYPE' || key === 'TYPE_STUDY_FIRST' || key === 'TYPE_GAME_FIRST';
}

function typeSequence(key: ItemSortKey, present: ReadonlySet<ItemType>): readonly ItemType[] {
	return (TYPE_SORT_STATES[key] ?? []).filter((type) => present.has(type));
}

function manualPositions(items: readonly ItemSummary[]): ReadonlyMap<number, number> {
	const ordered = [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
	return new Map(ordered.map((item, index) => [item.id, index + 1]));
}

function render(
	item: ItemSummary,
	number: number,
	columns: readonly ColumnDefinition[],
	mergesDocumentColumns: boolean,
): RenderedItem {
	const isDocument = item.shape === 'DOCUMENT';

	const first = isDocument ? (item.title ?? UNTITLED) : (item.white ?? UNKNOWN_NAME);
	const second = isDocument ? (item.author ?? '') : (item.black ?? UNKNOWN_NAME);
	const result = isDocument ? '' : (item.result ?? UNKNOWN_RESULT);

	const values: Readonly<Record<string, string>> = {
		number: String(number),
		type: ITEM_TYPE_LABEL[item.itemType],
		first,
		firstElo: isDocument ? '' : blankIfNull(item.whiteElo),
		result,
		second,
		secondElo: isDocument ? '' : blankIfNull(item.blackElo),
		annotator: item.author ?? '',
		eco: item.eco ?? '',
		moves: item.plyCount > 0 ? String(Math.ceil(item.plyCount / 2)) : '',
		date: isDocument ? '' : (item.date ?? (item.year !== null ? String(item.year) : UNKNOWN_DATE)),
		changed: item.updatedAt.slice(0, 10),
		event: item.event ?? '',
	};

	const unknown = new Set<string>();
	if (!isDocument) {
		if (item.white === null) unknown.add('first');
		if (item.black === null) unknown.add('second');
		if (item.result === null) unknown.add('result');
		if (item.date === null && item.year === null) unknown.add('date');
	} else if (item.title === null) {
		unknown.add('first');
	}

	return {
		id: item.id,
		itemType: item.itemType,
		badge: ITEM_TYPE_LABEL[item.itemType],
		number,
		isDocument,
		cells: layOut(columns, values, unknown, isDocument && mergesDocumentColumns),
		first,
		result,
		second,
	};
}

function layOut(
	columns: readonly ColumnDefinition[],
	values: Readonly<Record<string, string>>,
	unknown: ReadonlySet<string>,
	merge: boolean,
): readonly RenderedCell[] {
	const cells: RenderedCell[] = [];

	for (let i = 0; i < columns.length; i++) {
		const column = columns[i];
		if (!column) {
			continue;
		}

		const next = columns[i + 1];
		const spans = merge && next !== undefined && MERGE_INTO[column.key] === next.key;

		cells.push({
			key: column.key,
			classes: classesFor(column, unknown.has(column.key)),
			colspan: spans ? 2 : null,
			text: values[column.key] ?? '',
		});

		if (spans) {
			i++;
		}
	}
	return cells;
}

function classesFor(column: ColumnDefinition, unknown: boolean): string {
	return `${column.align} ${column.cell}${unknown ? ' unknown' : ''}`;
}

function blankIfNull(value: number | null): string {
	return value === null ? '' : String(value);
}

function storedColumnOrder(): readonly string[] | null {
	try {
		const raw = localStorage.getItem(COLUMN_ORDER_KEY);
		if (!raw) {
			return null;
		}

		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== 'string')) {
			return null;
		}

		const stored = parsed as string[];
		const known = new Set(COLUMNS.map((column) => column.key));
		const matches =
			stored.length === known.size && stored.every((key) => known.has(key)) && new Set(stored).size === stored.length;

		return matches ? stored : null;
	} catch {
		return null;
	}
}

function storeColumnOrder(order: readonly string[]): void {
	try {
		localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(order));
	} catch {
		// Column order is a convenience; losing it is not worth surfacing.
	}
}

function isTyping(target: EventTarget | null): boolean {
	const element = target as HTMLElement | null;
	if (!element) {
		return false;
	}
	const tag = element.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

function fileName(name: string): string {
	const cleaned = name
		.trim()
		.replace(/[\\/:*?"<>|]/g, '-')
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 80) : 'collection';
}
