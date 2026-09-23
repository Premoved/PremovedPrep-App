import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	DestroyRef,
	ElementRef,
	HostListener,
	OnDestroy,
	ViewChild,
	computed,
	effect,
	inject,
	input,
	signal,
	untracked,
	viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, of, shareReplay } from 'rxjs';
import { DEFAULT_FEN } from '../../core/chess/fen.util';
import { composePgnFile } from '../../core/chess/pgn-file';
import { PgnParserService } from '../../core/chess/pgn-parser.service';
import { uciOf } from '../../core/chess/uci-notation';
import { AnalysisDraftStore } from '../../core/services/analysis-draft.store';
import { PgnSerializerService } from '../../core/chess/pgn-serializer.service';
import { ItemType } from '../../core/models/collection.model';
import { RepertoireTree } from '../../core/models/repertoire.model';
import { OpponentScope, SearchColor } from '../../core/models/search.model';
import { NotificationService } from '../../core/services/notification.service';
import { CloudStorageService } from '../../core/services/cloud-storage.service';
import { CollectionApiService } from '../../core/services/collection-api.service';
import { LocalShelfService } from '../../core/agent/local-shelf.service';
import { LocalOpenEntry } from '../../core/agent/agent.models';
import { ConfirmService } from '../../core/services/confirm.service';
import { OpeningExplorerService } from '../../core/services/opening-explorer.service';
import { ViewportService } from '../../core/layout/viewport.service';
import { FrameResizeObserver } from '../../core/browser/frame-resize-observer';
import { AuthService } from '../../core/services/auth.service';
import { AnalyticsService } from '../../core/analytics/analytics.service';
import { AnalyticsEvent } from '../../core/analytics/analytics.events';
import { ReportApiService } from '../../core/services/report-api.service';
import { BoardToolbarComponent } from './board-toolbar/board-toolbar.component';
import { SavedEntry } from './board-toolbar/game-file-dialog.component';
import { ChessBoardComponent } from './chess-board/chess-board.component';
import { NotationPanelComponent } from './notation-panel/notation-panel.component';
import { EngineStore } from './state/engine.store';
import { TablebaseStore } from './state/tablebase.store';
import { GameListStore } from './state/game-list.store';
import { GamePreviewStore } from './state/game-preview.store';
import { MoveTreeStore } from './state/move-tree.store';
import { TabsStore } from '../../core/tabs/tabs.store';
import { gameHeadersLabel } from '../../core/chess/game-headers';
import { OpeningExplorerStore } from './state/opening-explorer.store';
import { ReportStore } from './state/report.store';

@Component({
	selector: 'app-analysis-board',
	standalone: true,
	imports: [BoardToolbarComponent, ChessBoardComponent, NotationPanelComponent],
	templateUrl: './analysis-board.component.html',
	styleUrl: './analysis-board.component.scss',
	providers: [
		MoveTreeStore,
		EngineStore,
		TablebaseStore,
		OpeningExplorerStore,
		GameListStore,
		GamePreviewStore,
		ReportStore,
	],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalysisBoardComponent implements AfterViewInit, OnDestroy {
	private readonly engine = inject(EngineStore);
	private readonly tree = inject(MoveTreeStore);
	private readonly tabs = inject(TabsStore);
	private readonly preview = inject(GamePreviewStore);
	private readonly explorer = inject(OpeningExplorerStore);
	private readonly api = inject(OpeningExplorerService);
	readonly viewport = inject(ViewportService);
	readonly report = inject(ReportStore);
	private readonly reportApi = inject(ReportApiService);
	private readonly auth = inject(AuthService);
	private readonly analytics = inject(AnalyticsService);
	private readonly pgn = inject(PgnParserService);
	private readonly drafts = inject(AnalysisDraftStore);
	private readonly serializer = inject(PgnSerializerService);
	private readonly notify = inject(NotificationService);
	private readonly cloud = inject(CloudStorageService);
	private readonly collections = inject(CollectionApiService);
	private readonly localShelf = inject(LocalShelfService);
	private readonly router = inject(Router);
	private readonly confirmDialog = inject(ConfirmService);

	readonly game = input<string | undefined>(undefined);

	private loadedGame?: string;

	readonly item = input<string | undefined>(undefined);

	readonly local = input<string | undefined>(undefined);

	private loadedLocal?: string;

	private loadedItem?: string;

	// Forces the board to the repertoire's colour once per tab, on the first entry opened onto it;
	// a manual flip after that is never overridden by a later navigation inside the same tab.
	private orientedForRepertoire = false;

	private loadedReport?: string;

	readonly ply = input<string | undefined>(undefined);

	private openAtPly(board: ChessBoardComponent): void {
		const line = this.line()?.trim();
		if (line) {
			this.tree.goToLine(line.split(',').filter((uci) => uci.length >= 4));
			board.refresh();
			return;
		}

		const ply = Number(this.ply());
		if (!Number.isInteger(ply) || ply <= 0) {
			return;
		}
		this.tree.goToMainlinePly(ply);
		board.refresh();
	}

	readonly line = input<string | undefined>(undefined);

	readonly opponent = input<string | undefined>(undefined);
	readonly oppColor = input<string | undefined>(undefined);
	readonly oppFrom = input<string | undefined>(undefined);
	readonly oppTo = input<string | undefined>(undefined);
	readonly oppName = input<string | undefined>(undefined);

	readonly reportMode = input(false, {
		// eslint-disable-next-line @angular-eslint/no-input-rename -- 'report' is the query parameter's own name
		alias: 'report',
		transform: (value: unknown) => value === '1' || value === true || value === 'true',
	});

	readonly opponentScope = computed<OpponentScope | null>(() => {
		const fideId = Number(this.opponent());
		if (!Number.isInteger(fideId) || fideId <= 0) {
			return null;
		}
		return {
			fideId,
			color: this.oppColor() === 'b' ? ('b' as SearchColor) : ('w' as SearchColor),
			from: this.oppFrom()?.trim() || null,
			to: this.oppTo()?.trim() || null,
			name: this.oppName()?.trim() || null,
		};
	});

	readonly opponentTreeOnly = computed(() => this.opponentScope() !== null && !this.reportMode());

	readonly opponentLabel = computed(() => {
		const scope = this.opponentScope();
		if (!scope) {
			return '';
		}
		const who = scope.name ?? `FIDE ${scope.fideId}`;
		return `${who} — as ${scope.color === 'b' ? 'Black' : 'White'}`;
	});

	// Strings, not ids: cloud siblings go in ?item=, local ones in ?local=; siblingsAre says which.
	private readonly siblings = signal<readonly string[]>([]);
	private readonly siblingsAre = signal<'cloud' | 'local'>('cloud');
	private siblingsOf?: string;

	readonly stepTargets = computed<{ previous: string | null; next: string | null }>(() => {
		const ids = this.siblings();
		const here = this.siblingsAre() === 'local' ? (this.local() ?? '') : (this.item() ?? '');
		const index = ids.indexOf(here);
		if (index < 0) {
			return { previous: null, next: null };
		}
		return { previous: ids[index - 1] ?? null, next: ids[index + 1] ?? null };
	});

	@ViewChild('mainRef') private mainRef!: ElementRef<HTMLElement>;
	@ViewChild('dividerRef') private dividerRef!: ElementRef<HTMLElement>;
	@ViewChild('boardPaneRef') private boardPaneRef?: ElementRef<HTMLElement>;
	private readonly hostEl = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;

	private readonly board = viewChild(ChessBoardComponent);

	dismissVariationPicker(): void {
		this.board()?.dismissVariationPicker();
	}

	private readonly toolbar = viewChild(BoardToolbarComponent);

	private resizeObserver?: FrameResizeObserver;

	readonly notationWidth = signal<number | null>(null);

	private readonly minNotationPx = signal(0);

	readonly resizing = signal(false);

	readonly handleOffset = signal<number | null>(null);

	readonly handleActive = signal(false);

	// Below this pane width the board freezes and the pane scrolls.
	private static readonly MIN_BOARD_PANE_PX = 370;

	// First guess at the board pane's width, before the board has measured itself.
	private static readonly BOARD_PANE_AT_MAX_PX = 767;

	private dividerWidth(): number {
		return this.dividerRef?.nativeElement.getBoundingClientRect().width ?? 0;
	}

	private clampNotation(width: number, containerWidth: number): number {
		const min = this.minNotationPx();
		const max = Math.max(min, containerWidth - this.dividerWidth() - AnalysisBoardComponent.MIN_BOARD_PANE_PX);
		return Math.min(Math.max(width, min), max);
	}

	private notationWidthAt(clientX: number, rect: DOMRect): number {
		return this.clampNotation(rect.right - clientX - this.dividerWidth() / 2, rect.width);
	}

	private defaultNotationWidth(containerWidth: number): number {
		return containerWidth - this.dividerWidth() - AnalysisBoardComponent.BOARD_PANE_AT_MAX_PX;
	}

	private dividerTouched = false;

	private draftTimer: ReturnType<typeof setTimeout> | null = null;
	private draftRestored = false;

	// Read once, at construction: a board off screen must keep writing to its own slot, not
	// whichever tab happens to be on screen. Empty in a browser, where drafts fall back to the tab.
	private readonly tabSlot = this.tabs.owningTab;

	// False: the last write failed, so quitting loses work.
	private draftKept = true;

	private scheduleDraft(): void {
		if (this.draftTimer !== null) {
			clearTimeout(this.draftTimer);
		}
		this.draftTimer = setTimeout(() => this.keepDraft(), 700);
	}

	// Called by the timer, and again by hasUnkeptWork() so the last few seconds before a close still count.
	private keepDraft(): boolean {
		this.draftTimer = null;

		if (!this.tree.isDirty()) {
			this.drafts.clear(this.tabSlot);
			this.draftKept = true;
			return true;
		}

		const headers = this.tree.headers();
		const root = this.tree.root();
		const kept = this.drafts.write(this.tabSlot, {
			pgn: composePgnFile({
				headers,
				startFen: root?.fen ?? DEFAULT_FEN,
				movetext: this.serializer.movetext(root),
				annotator: headers.annotator ?? null,
			}),
			line: this.cursorLine(),
			isStudy: this.tree.isStudy(),
			itemId: this.openItemId(),
			savedAt: Date.now(),
		});
		if (!kept && this.draftKept) {
			this.notify.error('This analysis is too large to autosave.');
		}
		this.draftKept = kept;
		return kept;
	}

	// True only when work would actually be lost: unsaved *and* the draft failed to write.
	hasUnkeptWork(): boolean {
		if (this.draftTimer !== null) {
			clearTimeout(this.draftTimer);
			this.keepDraft();
		}
		return this.tree.isDirty() && !this.draftKept;
	}

	private cursorLine(): string[] {
		const line: string[] = [];
		for (let node = this.tree.currentNode(); !node.isRoot; node = node.parent) {
			line.unshift(uciOf(node));
		}
		return line;
	}

	// Only restores a draft written for this same entry (or, with null, the tab's own blank board).
	private restoreDraft(board: ChessBoardComponent, forItem: number | null): boolean {
		const draft = this.drafts.read(this.tabSlot);
		if (!draft || draft.itemId !== forItem) {
			return false;
		}
		try {
			const parsed = this.pgn.parse(draft.pgn);
			this.tree.adopt(parsed.root, parsed.headers, draft.isStudy);
			board.refresh();
			this.tree.goToLine(draft.line);
			board.refresh();
			this.tree.markDirty();
			return true;
		} catch {
			this.drafts.clear(this.tabSlot);
			return false;
		}
	}

	constructor() {
		// Answers for its tab while detached (not destroyed) and off screen, which is the point of asking.
		this.tabs.claimTab(this.tabSlot, this);
		inject(DestroyRef).onDestroy(() => this.tabs.releaseTab(this.tabSlot, this));

		effect(() => {
			this.tabs.describe(gameHeadersLabel(this.tree.headers()));
		});

		effect(() => {
			this.tree.revision();
			this.tree.currentNode();
			this.tree.isDirty();
			untracked(() => this.scheduleDraft());
		});

		// A board opened with nothing in the URL is this tab's own analysis, from where it left off.
		effect(() => {
			const board = this.board();
			if (!board || this.draftRestored || this.game() || this.item() || this.local()) {
				return;
			}
			this.draftRestored = true;
			untracked(() => this.restoreDraft(board, null));
		});

		effect(() => {
			const preferred = this.board()?.layout.preferredPaneWidth();
			if (this.dividerTouched || preferred == null) return;

			const mainEl = this.mainRef?.nativeElement;
			if (!mainEl) return;
			const containerWidth = mainEl.getBoundingClientRect().width;
			if (containerWidth <= 0) return;

			const target = containerWidth - this.dividerWidth() - preferred;
			const current = this.notationWidth();
			if (current !== null && target <= current + 0.5) return;

			this.notationWidth.set(this.clampNotation(target, containerWidth));
		});

		effect(() => {
			this.board()?.setAutoShapes([...this.engine.boardShapes(), ...this.report.boardShapes()]);
		});

		effect(() => {
			this.preview.tree();
			const board = this.board();
			untracked(() => board?.refresh());
		});

		effect(() => {
			const scope = this.opponentScope();
			const board = this.board();
			if (!this.reportMode() || !scope || !board) {
				return;
			}
			const key = `${scope.fideId}|${scope.color}|${scope.from}|${scope.to}`;
			if (this.loadedReport === key) {
				return;
			}
			this.loadedReport = key;

			this.reportApi.advanced(scope).subscribe({
				next: (data) => {
					this.report.build(data);
					board.refresh();
					this.tree.markSaved();
					this.analytics.capture(AnalyticsEvent.advancedReportViewed, {
						authenticated: this.auth.isAuthenticated(),
						overlaps: data?.overlaps ?? 0,
						deviations: data?.deviations ?? 0,
						games_read: data?.gamesRead ?? 0,
						repertoire_files: data?.repertoireFiles ?? 0,
					});
				},
				error: (err: Error) => {
					this.report.build(null);
					this.notify.error(err.message);
				},
			});
		});

		effect(() => {
			this.tree.currentNode();
			this.tree.revision();
			untracked(() => this.report.syncToCursor());
		});

		effect(() => this.explorer.setScope(this.opponentScope()));

		effect(() => {
			const id = this.game();
			const board = this.board();
			if (!id || !board || this.loadedGame === id) return;

			this.loadedGame = id;
			this.api.game(Number(id)).subscribe({
				next: (detail) => {
					const parsed = this.pgn.parse(detail.pgn);
					this.tree.adopt(parsed.root, parsed.headers);
					board.refresh();
					this.openAtPly(board);
					this.tree.markSaved();
				},
			});
		});

		effect(() => {
			const id = this.item();
			const board = this.board();
			if (!id || this.game() || !board || this.loadedItem === id) return;

			this.loadedItem = id;

			const layer = this.preloadRepertoire(Number(id));

			this.collections.getItem(Number(id)).subscribe({
				next: (detail) => {
					const parsed = this.pgn.parse(detail.pgn);
					this.tree.adopt(parsed.root, parsed.headers, detail.itemType === 'STUDY');
					board.refresh();
					this.openAtPly(board);
					this.tree.markSaved();
					// Unsaved work this tab left on the same entry takes precedence over what the server holds.
					this.restoreDraft(board, Number(id));
					this.loadSiblings(detail.collectionId);

					// The board shows a cloud collection from here on.
					this.openLocalEntry.set(null);
					this.openItemType.set(detail.itemType);
					if (detail.itemType === 'MAIN_LINE') {
						this.applyRepertoire(layer, board, true);
					}
				},
			});
		});

		effect(() => {
			const id = this.local();
			const board = this.board();
			if (!id || this.game() || this.item() || !board || this.loadedLocal === id) return;

			this.loadedLocal = id;

			this.localShelf
				.entry(id)
				.then(async (detail) => {
					const parsed = this.pgn.parse(detail.pgn);
					this.tree.adopt(parsed.root, parsed.headers, detail.itemType === 'STUDY');
					board.refresh();
					this.openAtPly(board);
					this.tree.markSaved();

					// Type and colour: a .pgn carries no shelf, so the save dialog needs this to offer the
					// right types, and the repertoire layer below needs it to attach model games.
					this.openLocalEntry.set({
						id,
						kind: detail.kind,
						color: detail.color,
						itemType: detail.itemType as ItemType,
					});
					this.openItemType.set(detail.itemType as ItemType);
					this.loadLocalSiblings(detail.collectionId);

					if (detail.itemType === 'MAIN_LINE') {
						const links = await this.localShelf.repertoireTree(id).catch(() => null);
						this.applyRepertoire(of(links), board, true);
					}
				})
				.catch((error: Error) => {
					this.notify.error(error.message);
				});
		});
	}

	// Set only when the open entry came from a local file; null for a cloud entry or a database game.
	readonly openLocalEntry = signal<LocalOpenEntry | null>(null);

	private readonly openItemType = signal<ItemType | null>(null);

	private refreshRepertoire(itemId: number): void {
		this.applyRepertoire(this.preloadRepertoire(itemId), this.board(), false);
	}

	private preloadRepertoire(itemId: number): Observable<RepertoireTree | null> {
		return this.collections.repertoireTree(itemId).pipe(
			catchError(() => of(null)),
			shareReplay({ bufferSize: 1, refCount: false }),
		);
	}

	private applyRepertoire(
		layer: Observable<RepertoireTree | null>,
		board: ChessBoardComponent | undefined,
		reopen: boolean,
	): void {
		layer.subscribe((links) => {
			this.tree.applyRepertoireTree(links);
			const target = board ?? this.board();
			if (!target) {
				return;
			}
			// Only on the way in: a save must not pull the cursor back.
			if (reopen) {
				this.openAtPly(target);
				this.tree.markSaved();
				if (!this.orientedForRepertoire) {
					this.orientedForRepertoire = true;
					target.setOrientation(links?.color === 'b' ? 'black' : 'white');
				}
			}
			target.refresh();
		});
	}

	private loadSiblings(collectionId: number): void {
		const key = `cloud:${collectionId}`;
		if (this.siblingsOf === key) {
			return;
		}
		this.siblingsOf = key;
		this.siblingsAre.set('cloud');

		this.collections.listItems(collectionId, 'MANUAL', true).subscribe({
			next: (items) => this.siblings.set(items.map((item) => String(item.id))),
			error: () => this.siblings.set([]),
		});
	}

	// Same as loadSiblings, for a file: its entries are numbered by where they sit in it.
	private loadLocalSiblings(collectionId: string): void {
		const key = `local:${collectionId}`;
		if (this.siblingsOf === key) {
			return;
		}
		this.siblingsOf = key;
		this.siblingsAre.set('local');

		void this.localShelf
			.entries(collectionId)
			.then((entries) => this.siblings.set(entries.map((entry) => entry.id)))
			.catch(() => this.siblings.set([]));
	}

	readonly openItemId = computed(() => {
		if (this.game()) {
			return null;
		}
		const id = Number(this.item());
		return Number.isInteger(id) && id > 0 ? id : null;
	});

	openEntry(id: string | null): void {
		if (id === null) {
			return;
		}
		const local = this.siblingsAre() === 'local';
		void this.confirmDiscardOrSave().then((proceed) => {
			if (!proceed) {
				return;
			}
			void this.router.navigate([], {
				queryParams: local ? { local: id, item: null } : { item: id, local: null },
				queryParamsHandling: 'merge',
			});
		});
	}

	readonly confirmReplaceBoard = async (): Promise<boolean> => {
		if (!(await this.confirmDiscardOrSave())) {
			return false;
		}
		this.detachFromEntry();
		return true;
	};

	private detachFromEntry(): void {
		if (!this.game() && !this.item() && !this.local() && !this.ply() && !this.line()) {
			return;
		}
		void this.router.navigate([], {
			queryParams: { game: null, item: null, local: null, ply: null, line: null },
			queryParamsHandling: 'merge',
		});
	}

	async confirmDiscardOrSave(): Promise<boolean> {
		if (!this.tree.isDirty()) {
			return true;
		}
		const answer = await this.confirmDialog.askOrDismiss('Save changes?', {
			confirmLabel: 'Save',
			cancelLabel: 'Discard',
		});
		// Cross or Escape: stay, work remains unsaved.
		if (answer === 'dismiss') {
			return false;
		}
		if (answer === 'confirm') {
			return await this.quickSave();
		}
		return true;
	}

	async quickSave(): Promise<boolean> {
		const local = this.openLocalEntry();
		if (local !== null) {
			return await this.quickSaveLocally(local.id);
		}

		const itemId = this.openItemId();
		if (itemId === null) {
			this.toolbar()?.openGameDataPanel();
			return false;
		}

		const headers = this.tree.headers();
		const root = this.tree.root();
		const pgn = composePgnFile({
			headers,
			startFen: root?.fen ?? DEFAULT_FEN,
			movetext: this.serializer.movetext(root),
			annotator: headers.annotator ?? null,
		});

		return await new Promise<boolean>((resolve) => {
			this.collections.updateItem(itemId, pgn).subscribe({
				next: () => {
					this.tree.markSaved();
					// A trunk's own moves may also be moves a model game plays, so the layer is re-read.
					if (this.openItemType() === 'MAIN_LINE') {
						this.refreshRepertoire(itemId);
					}
					this.notify.info('Saved.');
					resolve(true);
				},
				error: (err: Error) => {
					if (!this.cloud.reportFull(err)) {
						this.notify.error(err.message);
					}
					resolve(false);
				},
			});
		});
	}

	@HostListener('window:keydown', ['$event'])
	onGlobalKeydown(event: KeyboardEvent): void {
		if (event.key.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
			return;
		}
		const target = event.target as HTMLElement | null;
		if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) {
			return;
		}
		event.preventDefault();
		void this.quickSave();
	}

	onSavedToCollection(entry: SavedEntry): void {
		this.siblingsOf = undefined;

		if (entry.localItemId && entry.localCollectionId) {
			this.loadedLocal = entry.localItemId;
			this.loadLocalSiblings(entry.localCollectionId);

			if (this.openItemType() === 'MAIN_LINE') {
				void this.localShelf
					.repertoireTree(entry.localItemId)
					.then((links) => this.applyRepertoire(of(links), this.board(), false))
					.catch(() => undefined);
			}
			void this.router.navigate([], {
				queryParams: { local: entry.localItemId, item: null },
				queryParamsHandling: 'merge',
			});
			return;
		}

		if (entry.itemId === null || entry.collectionId === null) {
			return;
		}

		this.loadedItem = String(entry.itemId);
		this.loadSiblings(entry.collectionId);

		if (this.openItemType() === 'MAIN_LINE') {
			this.refreshRepertoire(entry.itemId);
		}
		void this.router.navigate([], {
			queryParams: { item: entry.itemId, local: null },
			queryParamsHandling: 'merge',
		});
	}

	// Rewrites the entry where it sits, like Save on any open entry; no quota, nothing to seal, so
	// the only failure is the file having moved, which is worth surfacing rather than swallowing.
	private async quickSaveLocally(entryId: string): Promise<boolean> {
		const headers = this.tree.headers();
		const root = this.tree.root();
		const pgn = composePgnFile({
			headers,
			startFen: root?.fen ?? DEFAULT_FEN,
			movetext: this.serializer.movetext(root),
			annotator: headers.annotator ?? null,
		});

		try {
			await this.localShelf.replaceEntry(entryId, pgn);
			this.tree.markSaved();
			// A trunk's own moves may also be moves a model game plays, so the layer is re-read.
			if (this.openItemType() === 'MAIN_LINE') {
				const links = await this.localShelf.repertoireTree(entryId).catch(() => null);
				this.applyRepertoire(of(links), this.board(), false);
			}
			this.notify.info('Saved.');
			return true;
		} catch (error) {
			this.notify.error(error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	private applyClamp(containerWidth: number): void {
		if (containerWidth <= 0) {
			return;
		}
		const current = this.notationWidth();
		const target = current ?? this.defaultNotationWidth(containerWidth);
		const clamped = this.clampNotation(target, containerWidth);
		if (current === null || Math.abs(clamped - current) > 0.5) {
			this.notationWidth.set(clamped);
		}
	}

	onNotationMinWidth(px: number): void {
		this.minNotationPx.set(px);
		const mainEl = this.mainRef?.nativeElement;
		if (mainEl) {
			this.applyClamp(mainEl.getBoundingClientRect().width);
		}
	}

	ngAfterViewInit(): void {
		const mainEl = this.mainRef?.nativeElement;
		if (!mainEl) return;

		this.resizeObserver = new FrameResizeObserver(() => {
			this.applyClamp(mainEl.getBoundingClientRect().width);
			this.publishOverlayBounds();
		});
		this.resizeObserver.observe(mainEl);

		window.addEventListener('scroll', this.publishOverlayBounds, { passive: true });
		this.publishOverlayBounds();
	}

	private readonly publishOverlayBounds = (): void => {
		const style = this.hostEl.style;
		if (!this.viewport.isMobile()) {
			style.removeProperty('--board-overlay-top');
			style.removeProperty('--board-overlay-bottom');
			return;
		}

		const pane = this.boardPaneRef?.nativeElement.getBoundingClientRect();
		if (!pane) return;

		style.setProperty('--board-overlay-top', `${Math.round(pane.top)}px`);
		style.setProperty('--board-overlay-bottom', `${Math.round(pane.bottom)}px`);
	};

	// The page stays exactly as it is; the engine is a process, and EngineConcurrencyStore decides
	// whether it keeps running while this tab is not on screen.
	onTabHidden(): void {
		this.engine.setHidden(true);
	}

	onTabShown(): void {
		this.engine.setHidden(false);
	}

	ngOnDestroy(): void {
		if (this.draftTimer !== null) {
			clearTimeout(this.draftTimer);
		}
		window.removeEventListener('scroll', this.publishOverlayBounds);
		this.resizeObserver?.disconnect();
	}

	startResize(event: PointerEvent): void {
		event.preventDefault();
		this.dividerTouched = true;
		this.resizing.set(true);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onResize(event: PointerEvent, mainEl: HTMLElement): void {
		if (!this.resizing()) {
			return;
		}
		this.notationWidth.set(this.notationWidthAt(event.clientX, mainEl.getBoundingClientRect()));
	}

	stopResize(): void {
		this.resizing.set(false);
	}

	onHandlePointerDown(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.dividerTouched = true;
		this.handleActive.set(true);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onHandleDrag(event: PointerEvent, mainEl: HTMLElement): void {
		if (!this.handleActive()) {
			return;
		}
		event.preventDefault();
		const rect = mainEl.getBoundingClientRect();

		this.notationWidth.set(this.notationWidthAt(event.clientX, rect));

		const handleHeight = (event.currentTarget as HTMLElement).offsetHeight;
		const yMin = 16;
		const yMax = rect.height - yMin - handleHeight;
		const y = Math.min(Math.max(event.clientY - rect.top, yMin), yMax);
		this.handleOffset.set(y);
	}

	onHandlePointerUp(event: PointerEvent): void {
		if (!this.handleActive()) {
			return;
		}
		event.stopPropagation();
		this.handleActive.set(false);
	}
}
