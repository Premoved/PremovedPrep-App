import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	HostListener,
	Input,
	OnDestroy,
	OnInit,
	ViewChild,
	computed,
	effect,
	inject,
	signal,
	untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Chessground } from '@lichess-org/chessground';
import { Api } from '@lichess-org/chessground/api';
import { Config } from '@lichess-org/chessground/config';
import { DrawShape } from '@lichess-org/chessground/draw';
import { Color as CgColor, Key, Pieces } from '@lichess-org/chessground/types';
import { Chess, Square } from 'chess.js';
import { copyText } from '../../../core/browser/clipboard';
import { composePgnFile, pgnFileName } from '../../../core/chess/pgn-file';
import { PgnParserService } from '../../../core/chess/pgn-parser.service';
import { PgnSerializerService } from '../../../core/chess/pgn-serializer.service';
import { DEFAULT_FEN, activeColor } from '../../../core/chess/fen.util';
import { Color, PieceType, SquareName } from '../../../core/models/chess-enums';
import { MoveNode, PlyNode } from '../../../core/models/move-node.model';
import { NotificationService } from '../../../core/services/notification.service';
import { PreferencesStore } from '../../../core/services/preferences.store';
import { BoardSound, MoveSoundService } from '../../../core/sound/move-sound.service';
import { arrowBrushes } from '../../../core/models/preferences.model';
import { GamePreviewStore } from '../state/game-preview.store';
import { MoveTreeStore } from '../state/move-tree.store';
import { BoardImageService } from './board-image.service';
import { BoardLayoutService } from './board-layout.service';
import { ImportDialogComponent } from './import-dialog/import-dialog.component';
import { PromotionOverlayComponent, PromotionTarget } from './promotion-overlay/promotion-overlay.component';
import { SetupBoardComponent } from './setup-board/setup-board.component';
import { VariationPickerComponent } from './variation-picker/variation-picker.component';

/** chessground's Config has no `pieces` field, but the API accepts one. */
type BoardConfig = Config & { pieces?: Pieces };

const ENGINE_BRUSH = { key: 'engine', color: '#3d78ad', opacity: 1, lineWidth: 10 };

// Fixed colors, not the user's arrow-brush palette, so a report reads the same on every screen.
const REPORT_BRUSHES = {
	reportDeviation: { key: 'reportDeviation', color: '#c62828', opacity: 1, lineWidth: 10 },
	reportOverlap: { key: 'reportOverlap', color: '#ff8c00', opacity: 1, lineWidth: 10 },
	reportTrunk: { key: 'reportTrunk', color: '#5c5c5c', opacity: 0.75, lineWidth: 7 }, // thin/translucent: marks the path, not a point of interest
};

const LONG_PRESS_DRAW_MS = 450;

const TOOLTIP_HOLD_MS = 2500;

const COPY_FEEDBACK_MS = 2000;
const MOVE_ANIMATION_MS = 200;
const ANIMATION_RESTORE_MS = 10;

const TOOLTIP_GAP = 10;

interface UtilityTooltip {
	readonly text: string;
	readonly above: boolean;
	readonly x: number;
	readonly y: number;
}

function isPromotionNode(node: MoveNode | undefined): boolean {
	return node !== undefined && !node.isRoot && node.promotion !== undefined;
}

const NO_STYLE: Record<string, string> = {};

@Component({
	selector: 'app-chess-board',
	standalone: true,
	imports: [
		NgTemplateOutlet,
		ImportDialogComponent,
		PromotionOverlayComponent,
		SetupBoardComponent,
		VariationPickerComponent,
	],
	templateUrl: './chess-board.component.html',
	styleUrl: './chess-board.component.scss',
	providers: [BoardLayoutService],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChessBoardComponent implements OnInit, AfterViewInit, OnDestroy {
	@ViewChild('boardEl') private boardElRef!: ElementRef<HTMLElement>;
	@ViewChild('boardShellEl') private boardShellRef!: ElementRef<HTMLElement>;
	@ViewChild('boardRowEl') private boardRowRef!: ElementRef<HTMLElement>;
	@ViewChild('boardColumnEl') private boardColumnRef!: ElementRef<HTMLElement>;
	@ViewChild('boardSquareEl') private boardSquareContainerRef!: ElementRef<HTMLElement>;
	@ViewChild('boardControlsEl') private boardControlsRef!: ElementRef<HTMLElement>;
	@ViewChild(SetupBoardComponent) private setupBoard?: SetupBoardComponent;

	@Input() startingFen: string = DEFAULT_FEN;

	@Input() showUtilities = true;

	@Input() confirmReplace: () => Promise<boolean> = () => Promise.resolve(true);

	private readonly pgnSerializer = inject(PgnSerializerService);
	private readonly pgnParser = inject(PgnParserService);
	private readonly notifications = inject(NotificationService);
	private readonly boardImage = inject(BoardImageService);
	private readonly prefs = inject(PreferencesStore);
	private readonly sounds = inject(MoveSoundService);
	private readonly tree = inject(MoveTreeStore);
	private readonly preview = inject(GamePreviewStore);
	readonly layout = inject(BoardLayoutService);

	private cgApi?: Api;
	private game = new Chess();

	readonly showUtilityButtons = signal(false);

	readonly tooltip = signal<UtilityTooltip | null>(null);
	readonly showCoordinates = signal(this.prefs.coordinates());
	readonly moveDestStyle = computed(() => this.prefs.moveDests());
	readonly boardOrientation = signal<CgColor>('white');

	readonly showVariationPicker = signal(false);
	readonly pendingVariations = signal<PlyNode[]>([]);
	readonly selectedIndex = signal(0);

	readonly promotionData = signal<PromotionTarget | null>(null);

	readonly showImportModal = signal(false);
	readonly importFen = signal('');
	readonly isFenCopied = signal(false);
	readonly isPgnCopied = signal(false);

	readonly isSetupMode = signal(false);
	readonly setupInitialFen = signal('start');
	readonly setupStartsFlipped = signal(false);
	private setupOriginalFen?: string;

	private isDrawingGesture = false;
	private touchStartSquare: Key | null = null;
	private touchStartHadPiece = false;
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;
	private touchListenersCleanup: (() => void)[] = [];

	private lastSyncedNode?: MoveNode;

	private lastSyncedTree?: MoveTreeStore;

	private pressingBoard = false;

	readonly promotionStyle = computed<Record<string, string>>(() => {
		const target = this.promotionData();
		if (!target) return NO_STYLE;

		this.layout.squareSize();
		const flipped = this.boardOrientation() === 'black';

		const boardEl = this.boardNativeEl?.querySelector('cg-board') as HTMLElement | null;
		if (!boardEl) return NO_STYLE;

		const squareSize = boardEl.clientWidth / 8;
		const file = target.to.charCodeAt(0) - 97;
		const rank = parseInt(target.to[1], 10) - 1;

		const fileIndex = flipped ? 7 - file : file;
		const rankIndex = flipped ? rank : 7 - rank;

		const baseTop = rankIndex * squareSize;
		const top = rankIndex === 0 ? baseTop : baseTop - 3 * squareSize;

		return {
			position: 'absolute',
			left: `${fileIndex * squareSize}px`,
			top: `${top}px`,
			width: `${squareSize}px`,
			height: `${squareSize * 4}px`,
			zIndex: '1000',
			display: 'flex',
			flexDirection: rankIndex === 0 ? 'column' : 'column-reverse',
		};
	});

	private boardTree(): MoveTreeStore | null {
		return this.preview.isActive() ? this.preview.tree() : this.tree;
	}

	private visibleDrawings(): DrawShape[] {
		return this.boardTree()?.visibleDrawings() ?? [];
	}

	readonly atStart = computed(() => this.boardTree()?.isAtRoot() ?? true);

	readonly canStepForward = computed(() => this.boardTree()?.canGoForward() ?? false);

	constructor() {
		effect(() => {
			const isStudy = this.tree.isStudy();
			const root = this.tree.root();
			if (!isStudy) return;

			const wanted: CgColor = activeColor(root.fen) === Color.BLACK ? 'black' : 'white';
			untracked(() => {
				if (this.boardOrientation() === wanted) return;
				this.boardOrientation.set(wanted);
				this.cgApi?.set({ orientation: wanted });
			});
		});

		effect(() => {
			const colours = this.prefs.arrowColors();
			const coordinates = this.prefs.coordinates();

			untracked(() => {
				this.cgApi?.set({
					drawable: { brushes: { ...arrowBrushes(colours), engine: ENGINE_BRUSH, ...REPORT_BRUSHES } },
				});

				if (this.showCoordinates() === coordinates) return;
				this.showCoordinates.set(coordinates);
				this.initBoard(this.game.fen());
			});
		});
	}

	ngOnInit(): void {
		this.game.load(this.startingFen);
		this.tree.reset(this.startingFen);
	}

	ngAfterViewInit(): void {
		this.initBoard();
		this.setupBoundsGuard();
		this.setupMobileDrawing();
		this.setupDrawingClearGuard();

		const shell = this.boardShellRef?.nativeElement;
		const row = this.boardRowRef?.nativeElement;
		const column = this.boardColumnRef?.nativeElement;
		const square = this.boardSquareContainerRef?.nativeElement;
		const controls = this.boardControlsRef?.nativeElement;
		if (shell && row && column && square && controls) {
			this.layout.attach(
				{ shell, row, column, square, controls },
				() => this.setupBoard?.contentHeight ?? null,
				this.showUtilities,
			);
		}
	}

	ngOnDestroy(): void {
		this.touchListenersCleanup.forEach((cleanup) => cleanup());
	}

	onSetupOverlayReady(contentHeight: number): void {
		this.layout.recompute(contentHeight);
	}

	private get boardNativeEl(): HTMLElement | undefined {
		return this.boardElRef?.nativeElement;
	}

	private initBoard(fen?: string): void {
		const container = this.boardNativeEl;
		if (!container) return;
		container.innerHTML = '';
		this.cgApi = Chessground(container, this.getBoardOptions(fen));
	}

	private lastBoardBox?: DOMRect;

	private setupBoundsGuard(): void {
		const container = this.boardNativeEl;
		if (!container) return;

		this.lastBoardBox = this.boardBox(container);

		const refresh = () => {
			const box = this.boardBox(container);
			const last = this.lastBoardBox;
			if (!box) return;

			const moved =
				!last ||
				Math.abs(box.left - last.left) > 0.5 ||
				Math.abs(box.top - last.top) > 0.5 ||
				Math.abs(box.width - last.width) > 0.5 ||
				Math.abs(box.height - last.height) > 0.5;

			if (moved) {
				this.lastBoardBox = box;
				this.cgApi?.redrawAll();
			}
		};

		container.addEventListener('pointerdown', refresh, { capture: true, passive: true });
		this.touchListenersCleanup.push(() => container.removeEventListener('pointerdown', refresh, { capture: true }));
	}

	private boardBox(container: HTMLElement): DOMRect | undefined {
		const board = container.querySelector('cg-board') as HTMLElement | null;
		return board?.getBoundingClientRect();
	}

	private getDests(): Map<Square, Square[]> {
		const dests = new Map<Square, Square[]>();
		this.game.moves({ verbose: true }).forEach((move) => {
			const list = dests.get(move.from) ?? [];
			list.push(move.to);
			dests.set(move.from, list);
		});
		return dests;
	}

	private getBoardOptions(fen?: string): BoardConfig {
		return {
			coordinates: this.showCoordinates(),
			fen: fen || this.game.fen() || this.startingFen,
			orientation: this.boardOrientation(),
			movable: {
				free: false,
				color: 'both',
				dests: this.getDests(),
				showDests: true,
				events: {
					after: (orig: Key, dest: Key) => {
						this.cgApi?.set({ animation: { enabled: false } });
						this.handleMove(orig, dest);

						setTimeout(() => {
							this.cgApi?.set({
								animation: { enabled: true, duration: MOVE_ANIMATION_MS },
								drawable: { shapes: this.visibleDrawings() },
							});
						}, ANIMATION_RESTORE_MS);
					},
				},
			},
			animation: { enabled: true, duration: MOVE_ANIMATION_MS },
			drawable: {
				enabled: true,
				visible: true,
				eraseOnMovablePieceClick: false, // renamed from eraseOnClick in chessground v10
				brushes: {
					...arrowBrushes(this.prefs.arrowColors()),
					engine: ENGINE_BRUSH,
					...REPORT_BRUSHES,
				},
				shapes: this.visibleDrawings(),
				onChange: (shapes: DrawShape[]) => {
					if (this.isDrawingGesture) return;

					// chessground wipes every shape on a plain press on an empty square.
					if (shapes.length === 0 && this.pressingBoard) {
						this.cgApi?.set({ drawable: { shapes: this.visibleDrawings() } });
						return;
					}

					const tree = this.boardTree();
					if (!tree) return;

					const stored = tree.replaceDrawings(shapes);
					if (stored.length !== shapes.length) {
						this.cgApi?.set({ drawable: { shapes: stored } });
					}
				},
			},
		};
	}

	private handleMove(orig: Key, dest: Key): void {
		if (this.isDrawingGesture) return;

		// chessground's Key allows 'a0', its off-board sentinel.
		const piece = this.game.get(orig as Square);
		const isPawn = piece?.type === 'p';
		const isPromotionRank = (piece?.color === 'w' && dest[1] === '8') || (piece?.color === 'b' && dest[1] === '1');

		if (isPawn && isPromotionRank && this.boardNativeEl) {
			this.cgApi?.set({ lastMove: [orig, dest], movable: { color: undefined } });
			this.promotionData.set({ from: orig, to: dest, isWhite: piece.color === 'w' });
			return;
		}

		this.executeMove(orig, dest, 'q');
	}

	executeMove(orig: string, dest: string, promotionPiece: string): void {
		const tree = this.boardTree();

		try {
			const move = tree ? this.game.move({ from: orig, to: dest, promotion: promotionPiece }) : null;
			if (move && tree) {
				tree.addMove({
					from: orig as SquareName,
					to: dest as SquareName,
					piece: move.piece.toUpperCase() as PieceType,
					color: move.color === 'w' ? Color.WHITE : Color.BLACK,
					san: move.san,
					fen: this.game.fen(),
					promotion: move.promotion ? (move.promotion.toUpperCase() as PieceType) : undefined,
				});
			}
		} catch (error) {
			console.error(error);
			this.notifications.error('Invalid move.');
		} finally {
			this.promotionData.set(null);
			tree?.setDrawingsVisible(true);
			this.syncBoard();
		}
	}

	onPromotionChosen(piece: string): void {
		const target = this.promotionData();
		if (!target) return;
		this.executeMove(target.from, target.to, piece);
	}

	cancelPromotion(): void {
		this.promotionData.set(null);
		this.syncBoard();
	}

	private syncBoard(): void {
		const tree = this.boardTree();
		if (!tree) {
			this.cgApi?.set({ fen: this.game.fen(), movable: { color: 'both', dests: this.getDests() } });
			return;
		}

		const current = tree.currentNode();
		const previous = this.lastSyncedNode;
		const previousTree = this.lastSyncedTree;
		this.lastSyncedNode = current;
		this.lastSyncedTree = tree;

		const targetFen = current.fen || DEFAULT_FEN;
		try {
			this.game.load(targetFen);
		} catch {
			console.error('Invalid FEN in syncBoard:', targetFen);
			return;
		}

		// Crossing between two trees is never a step, so it is never animated.
		const animate =
			previous !== current && previousTree === tree && !isPromotionNode(previous) && !isPromotionNode(current);

		this.cgApi?.set({
			fen: targetFen,
			turnColor: this.game.turn() === 'w' ? 'white' : 'black',
			movable: { color: 'both', dests: this.getDests() },
			drawable: { shapes: tree.visibleDrawings() },
			lastMove: current.isRoot ? undefined : [current.from as Key, current.to as Key],
			animation: { enabled: animate, duration: MOVE_ANIMATION_MS },
		});

		this.announce(previous, current, animate);
	}

	private announce(previous: MoveNode | undefined, current: MoveNode, animate: boolean): void {
		if (!animate || !this.prefs.sound()) return;

		const step = previous && !previous.isRoot && previous.parent === current ? previous : current;
		if (step.isRoot) return;

		this.sounds.play(soundFor(step.san), true);
	}

	selectMove(node: MoveNode): void {
		this.cancelPromotion();
		this.boardTree()?.select(node);
		this.syncBoard();
	}

	setAutoShapes(shapes: DrawShape[]): void {
		this.cgApi?.set({ drawable: { autoShapes: shapes } });
	}

	refresh(): void {
		this.cancelPromotion();
		this.syncBoard();
	}

	goBack(): void {
		this.cancelPromotion();

		if (this.showVariationPicker()) {
			this.showVariationPicker.set(false);
			return;
		}

		this.boardTree()?.goBack();
		this.syncBoard();
	}

	goForward(): void {
		this.cancelPromotion();

		if (this.showVariationPicker()) {
			this.pickVariation(this.pendingVariations()[this.selectedIndex()]);
			return;
		}

		const step = this.boardTree()?.goForward();
		if (!step) return;

		switch (step.kind) {
			case 'none':
				return;
			case 'drawings':
			case 'moved':
				this.syncBoard();
				return;
			case 'branch':
				this.pendingVariations.set(step.variations);
				this.selectedIndex.set(0);
				this.showVariationPicker.set(true);
				return;
		}
	}

	handleVariationKeydown(event: KeyboardEvent): void {
		if (!this.showVariationPicker()) return;

		const count = this.pendingVariations().length;
		switch (event.key) {
			case 'ArrowDown':
				this.selectedIndex.update((index) => (index + 1) % count);
				break;
			case 'ArrowUp':
				this.selectedIndex.update((index) => (index - 1 + count) % count);
				break;
			case 'ArrowRight':
			case 'Enter':
				this.pickVariation(this.pendingVariations()[this.selectedIndex()]);
				break;
			case 'ArrowLeft':
			case 'Escape':
				this.showVariationPicker.set(false);
				break;
		}

		event.preventDefault();
	}

	pickVariation(node: MoveNode): void {
		this.showVariationPicker.set(false);
		this.selectMove(node);
	}

	dismissVariationPicker(): void {
		this.showVariationPicker.set(false);
	}

	goToRoot(): void {
		this.cancelPromotion();
		this.boardTree()?.goToRoot();
		this.syncBoard();
	}

	goToLast(): void {
		this.cancelPromotion();
		this.boardTree()?.goToLast();
		this.syncBoard();
	}

	@HostListener('window:keydown', ['$event'])
	handleKeyboardEvent(event: KeyboardEvent): void {
		const target = event.target as HTMLElement;
		if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) {
			return;
		}

		if (this.showVariationPicker()) {
			this.handleVariationKeydown(event);
			return;
		}

		if (this.promotionData() && event.key === 'Escape') {
			this.cancelPromotion();
			event.preventDefault();
			return;
		}

		if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
			this.toggleOrientation();
			event.preventDefault();
			return;
		}

		if (this.preview.isActive()) {
			if (event.key === 'ArrowUp') {
				this.preview.selectPrevious();
				event.preventDefault();
				return;
			}
			if (event.key === 'ArrowDown') {
				this.preview.selectNext();
				event.preventDefault();
				return;
			}
		}

		switch (event.key) {
			case 'ArrowLeft':
				this.goBack();
				event.preventDefault();
				break;
			case 'ArrowRight':
				this.goForward();
				event.preventDefault();
				break;
			case 'ArrowUp':
				this.goToRoot();
				event.preventDefault();
				break;
			case 'ArrowDown':
				this.goToLast();
				event.preventDefault();
				break;
		}
	}

	toggleOrientation(): void {
		this.setOrientation(this.boardOrientation() === 'white' ? 'black' : 'white');
	}

	setOrientation(color: CgColor): void {
		if (this.boardOrientation() === color) {
			return;
		}
		this.boardOrientation.set(color);
		this.cgApi?.set({ orientation: color });
	}

	toggleCoordinates(): void {
		// chessground does not expose `coordinates` through .set(); the wrapper is re-created instead.
		this.showCoordinates.update((shown) => !shown);
		this.initBoard(this.game.fen());
	}

	showTooltip(event: Event): void {
		this.showTooltipFor(event.currentTarget as HTMLElement);
		if (event.type !== 'contextmenu') return;
		if (this.tooltipTimeout) clearTimeout(this.tooltipTimeout);
		this.tooltipTimeout = setTimeout(() => this.hideTooltip(), TOOLTIP_HOLD_MS);
	}

	@HostListener('contextmenu', ['$event'])
	onLongPressLabel(event: MouseEvent): void {
		const el = (event.target as HTMLElement | null)?.closest('[data-tooltip]') as HTMLElement | null;
		if (!el) return;
		this.showTooltipFor(el);
		if (this.tooltipTimeout) clearTimeout(this.tooltipTimeout);
		this.tooltipTimeout = setTimeout(() => this.hideTooltip(), TOOLTIP_HOLD_MS);
	}

	private tooltipTimeout: ReturnType<typeof setTimeout> | null = null;

	private showTooltipFor(el: HTMLElement): void {
		const text = el.dataset['tooltip'];
		if (!text) return;

		const rect = el.getBoundingClientRect();
		const above = this.layout.isNarrow();
		this.tooltip.set({
			text,
			above,
			x: above ? rect.left + rect.width / 2 : rect.right + TOOLTIP_GAP,
			y: above ? rect.top - TOOLTIP_GAP : rect.top + rect.height / 2,
		});
	}

	hideTooltip(): void {
		if (this.tooltipTimeout) {
			clearTimeout(this.tooltipTimeout);
			this.tooltipTimeout = null;
		}
		this.tooltip.set(null);
	}

	toggleUtilityButtons(): void {
		this.showUtilityButtons.update((shown) => !shown);
	}

	copyFEN(): void {
		this.copyToClipboard(this.game.fen(), this.isFenCopied);
	}

	copyPGN(): void {
		const pgn = this.exportPgn();
		if (pgn) this.copyToClipboard(pgn, this.isPgnCopied);
	}

	// composePgnFile adds the header roster and a start FEN; the serializer's movetext() alone omits both.
	private exportPgn(): string {
		const store = this.boardTree();
		const root = store?.root();
		if (!store || !root) {
			return '';
		}
		return composePgnFile({
			headers: store.headers(),
			startFen: root.fen ?? DEFAULT_FEN,
			movetext: this.pgnSerializer.movetext(root),
		});
	}

	private copyToClipboard(text: string, flag: { set(value: boolean): void }): void {
		void copyText(text).then((copied) => {
			if (!copied) {
				this.notifications.error('Could not copy to the clipboard.');
				return;
			}
			flag.set(true);
			setTimeout(() => flag.set(false), COPY_FEEDBACK_MS);
		});
	}

	savePGN(): void {
		const pgn = this.exportPgn();
		if (!pgn) return;

		const blob = new Blob([pgn], { type: 'text/plain' });
		const url = window.URL.createObjectURL(blob);
		const link = document.createElement('a');
		const headers = this.boardTree()?.headers() ?? {};

		link.download = `${pgnFileName(headers)}.pgn`;
		link.href = url;
		link.click();

		window.URL.revokeObjectURL(url);
	}

	downloadDiagram(): void {
		const boardElement = this.boardNativeEl?.querySelector('cg-board') as HTMLElement | null;
		if (!boardElement) return;

		void this.boardImage.downloadDiagram({
			boardElement,
			blackOriented: this.boardOrientation() === 'black',
			withCoordinates: this.showCoordinates(),
		});
	}

	openImportPanel(): void {
		this.importFen.set(this.game.fen());
		this.showImportModal.set(true);
	}

	async confirmFenImport(fen: string): Promise<void> {
		let next: string;
		try {
			const probe = new Chess();
			probe.load(fen);
			next = probe.fen();
		} catch {
			this.notifications.error('Invalid FEN!');
			return;
		}

		if (!(await this.confirmReplace())) {
			this.showImportModal.set(false);
			return;
		}

		this.preview.clear();
		this.game.load(next);
		this.tree.reset(next);
		this.syncBoard();
		this.showImportModal.set(false);
	}

	async confirmPgnImport(pgn: string): Promise<void> {
		if (!pgn.trim()) return;

		let parsed;
		try {
			parsed = this.pgnParser.parse(pgn);
		} catch {
			this.notifications.error('Could not read that PGN.');
			return;
		}

		if (!(await this.confirmReplace())) {
			this.showImportModal.set(false);
			return;
		}

		this.preview.clear();
		this.tree.adopt(parsed.root, parsed.headers);
		this.showImportModal.set(false);
		this.syncBoard();
	}

	toggleSetupMode(): void {
		if (this.isSetupMode()) {
			this.cancelSetup();
			return;
		}

		this.setupOriginalFen = this.game.fen();
		this.setupInitialFen.set(this.setupOriginalFen);
		this.setupStartsFlipped.set(this.boardOrientation() === 'black');
		this.isSetupMode.set(true);

		this.cgApi?.set({
			movable: { free: true, color: 'both' },
			selectable: { enabled: false },
			highlight: { lastMove: false, check: false },
		});
	}

	onSetupPreview(fen: string): void {
		this.cgApi?.set({ fen });
	}

	cancelSetup(): void {
		this.isSetupMode.set(false);
		if (this.setupOriginalFen) {
			this.initBoard(this.setupOriginalFen);
		}
	}

	async onSetupConfirmed(fullFen: string): Promise<void> {
		if (!(await this.confirmReplace())) {
			this.cancelSetup();
			return;
		}

		this.preview.clear();
		this.game.load(fullFen);
		this.tree.reset(fullFen);
		this.isSetupMode.set(false);
		this.initBoard(fullFen);
	}

	private setupDrawingClearGuard(): void {
		const boardEl = this.boardNativeEl;
		if (!boardEl) return;

		const onMouseDown = (event: MouseEvent) => {
			this.pressingBoard = event.button === 0 && !event.shiftKey;
		};
		const onTouchStart = () => {
			this.pressingBoard = true;
		};
		const onRelease = () => {
			this.pressingBoard = false;
		};

		boardEl.addEventListener('mousedown', onMouseDown, true);
		boardEl.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
		document.addEventListener('mouseup', onRelease, true);
		document.addEventListener('touchend', onRelease, true);

		this.touchListenersCleanup.push(() => {
			boardEl.removeEventListener('mousedown', onMouseDown, true);
			boardEl.removeEventListener('touchstart', onTouchStart, true);
			document.removeEventListener('mouseup', onRelease, true);
			document.removeEventListener('touchend', onRelease, true);
		});
	}

	private setupMobileDrawing(): void {
		const boardEl = this.boardNativeEl;
		if (!boardEl) return;

		const onTouchStart = (event: TouchEvent) => {
			this.touchStartSquare = this.getSquareFromTouch(event);
			this.isDrawingGesture = false;
			this.touchStartHadPiece =
				this.touchStartSquare !== null && this.cgApi?.state.pieces.has(this.touchStartSquare) === true;
			if (this.touchStartSquare) startLongPressTimer();
		};

		const claimForDrawing = (orig: Key, dropPieceNow: boolean) => {
			if (this.isDrawingGesture) return;
			this.isDrawingGesture = true;
			this.touchStartSquare = orig;
			this.boardTree()?.setDrawingsVisible(true);
			if (dropPieceNow) this.cgApi?.cancelMove();
			this.cgApi?.set({ movable: { color: undefined } });
		};

		const startLongPressTimer = () => {
			this.clearLongPress();
			this.longPressTimer = setTimeout(() => {
				this.longPressTimer = null;
				const orig = this.touchStartSquare;
				if (orig) claimForDrawing(orig, true);
			}, LONG_PRESS_DRAW_MS);
		};

		const onTouchMove = (event: TouchEvent) => {
			if (!this.touchStartSquare) return;

			const rect = boardEl.getBoundingClientRect();
			const touch = event.touches[0];
			const isOutside =
				touch.clientX < rect.left ||
				touch.clientX > rect.right ||
				touch.clientY < rect.top ||
				touch.clientY > rect.bottom;

			if (this.longPressTimer !== null && this.getSquareFromTouch(event) !== this.touchStartSquare) {
				this.clearLongPress();
			}

			if (isOutside) {
				if (this.touchStartHadPiece) claimForDrawing(this.touchStartSquare, false);
				if (this.isDrawingGesture && event.cancelable) event.preventDefault();
				return;
			}

			if (this.isDrawingGesture) {
				if (event.cancelable) event.preventDefault();
				const currentSquare = this.getSquareFromTouch(event);
				if (currentSquare) {
					const shape: DrawShape = { orig: this.touchStartSquare, dest: currentSquare, brush: 'green' };
					const drawn = this.boardTree()?.currentNode().drawings ?? [];
					this.cgApi?.set({ drawable: { shapes: [...drawn, shape] } });
				}
			}
		};

		const onTouchEnd = (event: TouchEvent) => {
			this.clearLongPress();

			if (!this.isDrawingGesture) {
				this.touchStartSquare = null;
				return;
			}

			this.cgApi?.cancelMove();

			const finalSquare = this.getSquareFromTouch(event);
			if (this.touchStartSquare && finalSquare) {
				this.boardTree()?.appendDrawings([{ orig: this.touchStartSquare, dest: finalSquare, brush: 'green' }]);
			}

			this.isDrawingGesture = false;
			this.touchStartSquare = null;
			this.syncBoard();
		};

		// touchmove and touchend must not be passive: they call preventDefault.
		boardEl.addEventListener('touchstart', onTouchStart, { passive: true });
		boardEl.addEventListener('touchmove', onTouchMove, { passive: false });
		boardEl.addEventListener('touchend', onTouchEnd, { passive: false });
		boardEl.addEventListener('touchcancel', onTouchEnd, { passive: false });

		this.touchListenersCleanup.push(() => {
			this.clearLongPress();
			boardEl.removeEventListener('touchstart', onTouchStart);
			boardEl.removeEventListener('touchmove', onTouchMove);
			boardEl.removeEventListener('touchend', onTouchEnd);
			boardEl.removeEventListener('touchcancel', onTouchEnd);
		});
	}

	private clearLongPress(): void {
		if (this.longPressTimer === null) return;
		clearTimeout(this.longPressTimer);
		this.longPressTimer = null;
	}

	private getSquareFromTouch(event: TouchEvent): Key | null {
		const touch = event.touches[0] || event.changedTouches[0];
		return touch ? this.getSquareFromPoint(touch.clientX, touch.clientY) : null;
	}

	private getSquareFromPoint(clientX: number, clientY: number): Key | null {
		const boardEl = this.boardNativeEl;
		if (!boardEl) return null;

		const rect = boardEl.getBoundingClientRect();

		const col = Math.floor(((clientX - rect.left) / rect.width) * 8);
		const row = Math.floor(((clientY - rect.top) / rect.height) * 8);

		const flipped = this.boardOrientation() === 'black';
		const finalCol = flipped ? 7 - col : col;
		const finalRow = flipped ? row : 7 - row;

		if (finalCol < 0 || finalCol > 7 || finalRow < 0 || finalRow > 7) {
			return null;
		}

		return (String.fromCharCode(97 + finalCol) + (finalRow + 1)) as Key;
	}
}

function soundFor(san: string): BoardSound {
	// SAN marks castling as O-O/O-O-O, with an optional check or mate suffix.
	if (/^O-O(-O)?[+#]?$/.test(san)) {
		return 'castle';
	}
	return san.includes('x') ? 'capture' : 'move';
}
