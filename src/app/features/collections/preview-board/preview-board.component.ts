import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	HostListener,
	OnDestroy,
	computed,
	effect,
	inject,
	input,
	output,
	signal,
	untracked,
	viewChild,
} from '@angular/core';
import { Chessground } from '@lichess-org/chessground';
import { Api } from '@lichess-org/chessground/api';
import { Key } from '@lichess-org/chessground/types';
import { DEFAULT_FEN } from '../../../core/chess/fen.util';
import { moveNumberPrefix } from '../../../core/chess/move-number';
import { gameLabel } from '../../../core/chess/game-label';
import { CollectionApiService } from '../../../core/services/collection-api.service';
import { PreferencesStore } from '../../../core/services/preferences.store';
import { arrowBrushes } from '../../../core/models/preferences.model';
import { PgnParserService } from '../../../core/chess/pgn-parser.service';
import { Color } from '../../../core/models/chess-enums';
import { ItemType, RepertoireColor } from '../../../core/models/collection.model';
import { MoveNode, PlyNode } from '../../../core/models/move-node.model';
import { MoveTreeStore } from '../../analysis-board/state/move-tree.store';
import { VariationPickerComponent } from '../../analysis-board/chess-board/variation-picker/variation-picker.component';
import { fitOnScreen } from '../../../core/browser/menu-placement';
import { ViewportService } from '../../../core/layout/viewport.service';
import { formatGameDate } from '../../../core/chess/game-headers';
import { FrameResizeObserver } from '../../../core/browser/frame-resize-observer';

const MOVE_ANIMATION_MS = 200;

const COLUMN_CHROME_PX = 33;

const BOARD_INSET_PX = 19;

const MIN_DIVIDER_SHARE = 0.5;
const MAX_DIVIDER_SHARE = 0.67;

const HANDLE_MARGIN_PX = 24;

interface MoveToken {
	readonly node: PlyNode;
	readonly number: string;
	readonly san: string;
	readonly annotation: string;
	readonly comment: string;
	readonly generated: boolean;
	readonly games: readonly string[];
}

interface MoveSegment {
	readonly depth: number;
	readonly tokens: readonly MoveToken[];
}

const MENU_FOOTPRINT = { width: 208, height: 132 };

@Component({
	selector: 'app-preview-board',
	standalone: true,
	imports: [VariationPickerComponent],
	templateUrl: './preview-board.component.html',
	styleUrl: './preview-board.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
/** A read-only board with the game's moves beneath it. Used by the collection preview pane. */
export class PreviewBoardComponent implements AfterViewInit, OnDestroy {
	private readonly parser = inject(PgnParserService);
	private readonly collections = inject(CollectionApiService);
	private readonly prefs = inject(PreferencesStore);
	private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
	private readonly boardEl = viewChild.required<ElementRef<HTMLElement>>('boardEl');
	private readonly columnEl = viewChild.required<ElementRef<HTMLElement>>('columnEl');
	private readonly controlsEl = viewChild.required<ElementRef<HTMLElement>>('controlsEl');

	readonly pgn = input.required<string | null>();

	readonly itemType = input<ItemType | null>(null);

	readonly itemId = input<number | null>(null);

	// The collection's own colour, for a board's initial orientation only (see ngAfterViewInit).
	readonly collectionColor = input<RepertoireColor | null>(null);

	readonly previousRequested = output<void>();
	readonly nextRequested = output<void>();

	private api?: Api;
	private resizeObserver?: FrameResizeObserver;

	private readonly tree = signal<MoveTreeStore | null>(null);

	readonly viewport = inject(ViewportService);

	readonly headers = computed(() => this.tree()?.headers() ?? null);

	readonly gameDate = computed(() => formatGameDate(this.headers()?.date));

	readonly showVariationPicker = signal(false);
	readonly pendingVariations = signal<PlyNode[]>([]);
	readonly selectedIndex = signal(0);

	readonly unreadable = signal(false);

	readonly boardSize = signal(0);

	private readonly dividerRequest = signal<number | null>(null);

	readonly dividerActive = signal(false);
	readonly handleOffset = signal<number | null>(null);

	readonly squareSize = computed(() => this.boardSize() / 8);

	readonly atStart = computed(() => this.tree()?.isAtRoot() ?? true);
	readonly canStepForward = computed(() => this.tree()?.canGoForward() ?? false);

	readonly currentNode = computed<MoveNode | null>(() => this.tree()?.currentNode() ?? null);

	readonly isStudy = computed(() => this.tree()?.isStudy() ?? false);

	readonly rootSolutionHidden = computed(() => {
		const tree = this.tree();
		if (!tree) {
			return false;
		}
		tree.revision();
		return tree.isStudy() && tree.root().solutionFold === 'collapsed';
	});

	readonly segments = computed<readonly MoveSegment[]>(() => {
		const tree = this.tree();
		if (!tree) {
			return [];
		}
		tree.revision();
		return flatten(tree.root(), tree.isStudy());
	});

	private lastSyncedTree: MoveTreeStore | null = null;
	private lastSyncedNode?: MoveNode;

	constructor() {
		effect(() => {
			const pgn = this.pgn();
			// Untracked because everything below writes signals and touches the DOM.
			untracked(() => this.load(pgn));
		});

		effect(() => {
			this.currentNode();
			setTimeout(() => this.scrollCurrentMoveIntoView(), 0);
		});
	}

	private load(pgn: string | null): void {
		this.showVariationPicker.set(false);
		this.unreadable.set(false);

		if (!pgn) {
			this.tree.set(null);
			this.sync();
			return;
		}

		const store = new MoveTreeStore();
		try {
			const parsed = this.parser.parse(pgn);
			store.adopt(parsed.root, parsed.headers, this.itemType() === 'STUDY');
		} catch {
			this.tree.set(null);
			this.unreadable.set(true);
			this.sync();
			return;
		}

		this.tree.set(store);
		this.sync();
		this.loadRepertoireLinks(store);
	}

	private loadRepertoireLinks(store: MoveTreeStore): void {
		const id = this.itemId();
		if (this.itemType() !== 'MAIN_LINE' || id === null) {
			return;
		}

		this.collections.repertoireTree(id).subscribe({
			next: (links) => {
				// A later load() may already have replaced the tree while this request was in flight.
				if (this.tree() !== store) {
					return;
				}
				store.applyRepertoireTree(links);
				this.sync();
			},
			error: () => undefined,
		});
	}

	ngAfterViewInit(): void {
		const element = this.boardEl().nativeElement;

		// Set once, from the collection this board was opened for; a later flip is never overridden.
		this.orientation.set(this.collectionColor() === 'b' ? 'black' : 'white');

		this.api = Chessground(element, {
			coordinates: this.prefs.coordinates(),
			fen: DEFAULT_FEN,
			orientation: this.orientation(),
			// color: undefined is chessground's own lock, distinct from free/showDests.
			movable: { free: false, color: undefined, showDests: false },
			draggable: { enabled: false },
			selectable: { enabled: false },
			animation: { enabled: true, duration: MOVE_ANIMATION_MS },
			drawable: {
				enabled: false,
				visible: true,
				shapes: [],
				brushes: {
					...arrowBrushes(this.prefs.arrowColors()),
					engine: { key: 'engine', color: '#3d78ad', opacity: 1, lineWidth: 10 },
				},
			},
		});

		this.resizeObserver = new FrameResizeObserver(() => this.measure());
		this.resizeObserver.observe(this.columnEl().nativeElement);

		this.measure();
		this.sync();
	}

	ngOnDestroy(): void {
		this.resizeObserver?.disconnect();
		this.api?.destroy();
	}

	private measure(): void {
		const column = this.columnEl().nativeElement.getBoundingClientRect();
		const controls = this.controlsEl().nativeElement.getBoundingClientRect();

		if (column.width <= 0 || column.height <= 0) {
			return;
		}

		const chrome = controls.height + COLUMN_CHROME_PX;
		const floor = Math.max(0, column.height * MIN_DIVIDER_SHARE - chrome);
		const ceiling = Math.max(floor, column.height * MAX_DIVIDER_SHARE - chrome);

		const requested = (this.dividerRequest() ?? column.height * MAX_DIVIDER_SHARE) - chrome;

		const usableWidth = Math.max(0, column.width - BOARD_INSET_PX);
		const size = Math.max(0, Math.min(usableWidth, Math.min(Math.max(requested, floor), ceiling)));

		// Guarded because writing the signal resizes the element this observer watches.
		if (Math.abs(size - this.boardSize()) > 0.5) {
			this.boardSize.set(size);
			this.api?.redrawAll();
		}
	}

	startVerticalResize(event: PointerEvent): void {
		event.preventDefault();
		this.dividerActive.set(true);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onVerticalResize(event: PointerEvent): void {
		if (!this.dividerActive()) {
			return;
		}
		const column = this.columnEl().nativeElement.getBoundingClientRect();

		this.dividerRequest.set(event.clientY - column.top);
		this.measure();
	}

	onHandleDrag(event: PointerEvent): void {
		if (!this.dividerActive()) {
			return;
		}
		this.onVerticalResize(event);

		const column = this.columnEl().nativeElement.getBoundingClientRect();
		const x = event.clientX - column.left;
		this.handleOffset.set(
			Math.min(Math.max(x, HANDLE_MARGIN_PX), Math.max(column.width - HANDLE_MARGIN_PX, HANDLE_MARGIN_PX)),
		);
	}

	onHandlePointerDown(event: PointerEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.dividerActive.set(true);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	stopVerticalResize(): void {
		this.dividerActive.set(false);
	}

	private sync(): void {
		const api = this.api;
		if (!api) {
			return;
		}

		const tree = this.tree();
		if (!tree) {
			api.set({ fen: DEFAULT_FEN, lastMove: undefined, drawable: { shapes: [] } });
			this.lastSyncedTree = null;
			this.lastSyncedNode = undefined;
			return;
		}

		const node = tree.currentNode();
		const previousNode = this.lastSyncedNode;
		const previousTree = this.lastSyncedTree;
		this.lastSyncedNode = node;
		this.lastSyncedTree = tree;

		const fen = node.fen || DEFAULT_FEN;

		// Animate along a game, never into one.
		const animate = previousTree === tree && previousNode !== node;

		api.set({
			fen,
			turnColor: fen.split(' ')[1] === 'b' ? 'black' : 'white',
			lastMove: node.isRoot ? undefined : [node.from as Key, node.to as Key],
			drawable: { shapes: tree.visibleDrawings() },
			animation: { enabled: animate, duration: MOVE_ANIMATION_MS },
		});
	}

	goToRoot(): void {
		this.showVariationPicker.set(false);
		this.tree()?.goToRoot();
		this.sync();
	}

	toggleSolution(): void {
		const tree = this.tree();
		if (!tree) {
			return;
		}
		tree.toggleSolutionFold(tree.root());
	}

	goBack(): void {
		if (this.showVariationPicker()) {
			this.showVariationPicker.set(false);
			return;
		}
		this.tree()?.goBack();
		this.sync();
	}

	goForward(): void {
		if (this.showVariationPicker()) {
			this.pickVariation(this.pendingVariations()[this.selectedIndex()]);
			return;
		}

		const step = this.tree()?.goForward();
		if (!step) {
			return;
		}

		switch (step.kind) {
			case 'none':
				return;
			case 'drawings':
			case 'moved':
				this.sync();
				return;
			case 'branch':
				this.pendingVariations.set(step.variations);
				this.selectedIndex.set(0);
				this.showVariationPicker.set(true);
				return;
		}
	}

	goToLast(): void {
		this.showVariationPicker.set(false);
		this.tree()?.goToLast();
		this.sync();
	}

	pickVariation(node: MoveNode): void {
		this.showVariationPicker.set(false);
		this.tree()?.select(node);
		this.sync();
	}

	jumpTo(node: MoveNode): void {
		this.showVariationPicker.set(false);
		this.tree()?.select(node);
		this.sync();
	}

	private scrollCurrentMoveIntoView(): void {
		this.host.nativeElement.querySelector('.move.current')?.scrollIntoView({ block: 'center' });
	}

	readonly orientation = signal<'white' | 'black'>('white');

	flipBoard(): void {
		this.orientation.update((current) => (current === 'white' ? 'black' : 'white'));
		this.api?.set({ orientation: this.orientation() });
		this.boardMenu.set(null);
	}

	readonly boardMenu = signal<{ x: number; y: number } | null>(null);

	onBoardContextMenu(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.boardMenu.set(fitOnScreen(event.clientX, event.clientY, MENU_FOOTPRINT));
	}

	@HostListener('document:click')
	@HostListener('document:contextmenu')
	@HostListener('window:blur')
	closeBoardMenu(): void {
		this.boardMenu.set(null);
	}

	@HostListener('window:keydown', ['$event'])
	handleKeydown(event: KeyboardEvent): void {
		if (isTypingTarget(event.target)) {
			return;
		}

		if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
			this.flipBoard();
			event.preventDefault();
			return;
		}

		if (this.showVariationPicker()) {
			this.handleVariationKeydown(event);
			return;
		}

		switch (event.key) {
			case 'ArrowLeft':
				this.goBack();
				break;
			case 'ArrowRight':
				this.goForward();
				break;
			case 'Home':
				this.goToRoot();
				break;
			case 'End':
				this.goToLast();
				break;
			case 'ArrowUp':
				this.previousRequested.emit();
				break;
			case 'ArrowDown':
				this.nextRequested.emit();
				break;
			default:
				return;
		}

		event.preventDefault();
	}

	private handleVariationKeydown(event: KeyboardEvent): void {
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
			default:
				return;
		}

		event.preventDefault();
	}
}

function flatten(root: MoveNode, isStudy: boolean): MoveSegment[] {
	const segments: MoveSegment[] = [];
	walk(root, 0, segments, null, isStudy);
	return segments;
}

function walk(from: MoveNode, depth: number, out: MoveSegment[], first: PlyNode | null, isStudy: boolean): void {
	let tokens: MoveToken[] = [];
	let node: MoveNode = from;

	if (first) {
		if (isStudy && first.solutionFold === 'collapsed') {
			return;
		}
		tokens.push(token(first, true));
		node = first;
	}

	while (node.children.length > 0) {
		// A collapsed boundary hides everything after the node that carries it.
		if (isStudy && node.solutionFold === 'collapsed') {
			break;
		}

		const [mainline, ...sidelines] = node.children;

		tokens.push(token(mainline, tokens.length === 0));

		if (sidelines.length > 0) {
			out.push({ depth, tokens });
			tokens = [];
			for (const sideline of sidelines) {
				walk(sideline, depth + 1, out, sideline, isStudy);
			}
		}

		node = mainline;
	}

	if (tokens.length > 0) {
		out.push({ depth, tokens });
	}
}

function token(node: PlyNode, opensRun: boolean): MoveToken {
	const showsNumber = node.color === Color.WHITE || opensRun;

	return {
		node,
		number: showsNumber ? moveNumberPrefix(node) : '',
		san: node.san,
		annotation: node.annotation ?? '',
		comment: node.comment ?? '',
		generated: node.generated === true,
		games: (node.modelGames ?? []).map(gameLabel),
	};
}

function isTypingTarget(target: EventTarget | null): boolean {
	const element = target as HTMLElement | null;
	if (!element) {
		return false;
	}
	const tag = element.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}
