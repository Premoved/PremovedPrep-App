import { NgTemplateOutlet } from '@angular/common';
import {
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	HostListener,
	Injector,
	OnDestroy,
	afterNextRender,
	computed,
	effect,
	inject,
	output,
	signal,
} from '@angular/core';
import { moveNumberPrefix } from '../../../../core/chess/move-number';
import { formatGameDate } from '../../../../core/chess/game-headers';
import { gameLabel, gamePlayers } from '../../../../core/chess/game-label';
import { Annotation, Color } from '../../../../core/models/chess-enums';
import { MoveNode, PlyNode } from '../../../../core/models/move-node.model';
import { RepertoireGame } from '../../../../core/models/repertoire.model';
import { ReportBookFile, ReportGame, ReportPoint } from '../../../../core/models/report.model';
import { MoveTreeStore } from '../../state/move-tree.store';
import { TabsStore } from '../../../../core/tabs/tabs.store';
import { ReportStore } from '../../state/report.store';
import { MoveContextMenuComponent } from './move-context-menu/move-context-menu.component';
import { TooltipDirective } from '../../../../shared/tooltip/tooltip.directive';
import { scrollIntoContainer, scrollableAncestor } from '../../../../core/browser/scroll';

interface OpenMenu {
	readonly node: MoveNode;
	readonly anchor: DOMRect;
}

const LONG_PRESS_MS = 500;

@Component({
	selector: 'app-move-tree',
	standalone: true,
	imports: [NgTemplateOutlet, MoveContextMenuComponent, TooltipDirective],
	templateUrl: './move-tree.component.html',
	styleUrl: './move-tree.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MoveTreeComponent implements OnDestroy {
	readonly tree = inject(MoveTreeStore);

	private readonly report = inject(ReportStore);
	private readonly tabs = inject(TabsStore);

	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
	private readonly injector = inject(Injector);

	readonly moveSelected = output<MoveNode>();

	readonly positionChanged = output<void>();

	readonly openMenu = signal<OpenMenu | null>(null);

	readonly mainline = computed<readonly PlyNode[]>(() => {
		this.tree.revision();
		const first = this.tree.root().children[0];
		return first ? [first] : [];
	});

	readonly rootVariations = computed<readonly PlyNode[]>(() => {
		this.tree.revision();
		return this.tree.root().children.slice(1);
	});

	readonly rootHasDrawings = computed(() => {
		this.tree.revision();
		return this.tree.root().drawings.length > 0;
	});

	readonly rootModelGames = computed<readonly RepertoireGame[]>(() => {
		this.tree.revision();
		return this.tree.root().modelGames ?? [];
	});

	readonly rootSolutionHidden = computed(() => {
		this.tree.revision();
		return this.tree.isStudy() && this.tree.root().solutionFold === 'collapsed';
	});

	private pressTimer?: ReturnType<typeof setTimeout>;
	// Set when a long press opened the menu, so the click that follows is ignored.
	private longPressFired = false;

	private readonly nodeKeys = new Map<MoveNode, string>();
	private readonly keyToNode = new Map<string, MoveNode>();
	private nodeKeyCounter = 0;

	nodeKey(node: MoveNode): string {
		let key = this.nodeKeys.get(node);
		if (!key) {
			key = `n${this.nodeKeyCounter++}`;
			this.nodeKeys.set(node, key);
		}
		this.keyToNode.set(key, node);
		return key;
	}

	solutionCollapsed(node: MoveNode): boolean {
		return this.tree.isStudy() && node.solutionFold === 'collapsed';
	}

	constructor() {
		// Keeping the cursor visible is the notation panel's job, not the board's.
		effect(() => {
			this.tree.currentNode();
			this.tree.revision();
			afterNextRender(() => this.scrollActiveIntoView(), { injector: this.injector });
		});
	}

	ngOnDestroy(): void {
		clearTimeout(this.pressTimer);
	}

	protected readonly moveNumber = moveNumberPrefix;

	showsMoveNumber(node: PlyNode): boolean {
		return node.color === Color.WHITE || this.isFirstInVariation(node);
	}

	private isFirstInVariation(node: PlyNode): boolean {
		const parent = node.parent;
		// With the root hidden, the first move on screen has no context above it.
		if (parent.isRoot) return true;
		return parent.children.length > 1 && parent.children[0] !== node;
	}

	showsDrawings(node: MoveNode): boolean {
		return this.tree.currentNode() === node && this.tree.drawingsVisible();
	}

	onMoveClick(node: PlyNode): void {
		if (this.longPressFired) {
			this.longPressFired = false;
			return;
		}
		this.closeMenu();
		this.moveSelected.emit(node);
	}

	onContextMenu(event: MouseEvent, node: MoveNode): void {
		event.preventDefault();
		event.stopPropagation();
		this.open(node, event.currentTarget as HTMLElement);
	}

	onPointerDown(event: PointerEvent, node: MoveNode): void {
		if (event.pointerType === 'mouse') return;

		const target = event.currentTarget as HTMLElement;
		clearTimeout(this.pressTimer);
		this.longPressFired = false;
		this.pressTimer = setTimeout(() => {
			this.longPressFired = true;
			this.open(node, target);
			navigator.vibrate?.(50);
		}, LONG_PRESS_MS);
	}

	cancelLongPress(): void {
		clearTimeout(this.pressTimer);
	}

	private open(node: MoveNode, target: HTMLElement): void {
		this.openMenu.set({ node, anchor: target.getBoundingClientRect() });
	}

	closeMenu(): void {
		this.openMenu.set(null);
	}

	@HostListener('document:pointerdown', ['$event'])
	onDocumentPointerDown(event: PointerEvent): void {
		const target = event.target as HTMLElement;
		if (this.openMenu() && !target.closest('.move-context-menu')) {
			this.closeMenu();
		}
		if (this.iconMenu() && !target.closest('.icon-context-menu')) {
			this.closeIconMenu();
		}
	}

	@HostListener('document:keydown.escape')
	onEscape(): void {
		this.closeMenu();
		this.closeIconMenu();
	}

	promote(node: MoveNode): void {
		if (!node.isRoot) this.tree.promoteLine(node);
		this.closeMenu();
	}

	annotate(node: MoveNode, annotation: Annotation): void {
		if (!node.isRoot) {
			this.tree.setAnnotation(node, annotation === Annotation.EMPTY ? undefined : annotation);
		}
		this.closeMenu();
	}

	clearDrawings(node: MoveNode): void {
		this.tree.clearDrawings(node);
		this.closeMenu();
		this.positionChanged.emit();
	}

	deleteMove(node: MoveNode): void {
		if (!node.isRoot) this.tree.deleteNode(node);
		this.closeMenu();
		this.positionChanged.emit();
	}

	hasFoldingPoint(node: MoveNode): boolean {
		if (node.isRoot) return false;
		return this.tree.isStudy() ? node.solutionFold !== undefined : node.fold !== undefined;
	}

	foldActionDisabled(node: MoveNode): boolean {
		return this.tree.isStudy() && this.hasFoldingPoint(node) && !this.tree.canRemoveSolutionFold(node);
	}

	toggleFoldingPoint(node: MoveNode): void {
		if (!node.isRoot) {
			if (this.tree.isStudy()) {
				if (node.solutionFold === undefined) {
					this.tree.insertSolutionFold(node);
				} else {
					this.tree.removeSolutionFold(node);
				}
			} else if (node.fold === undefined) {
				this.tree.insertFoldingPoint(node);
			} else {
				this.tree.removeFoldingPoint(node);
			}
		}
		this.closeMenu();
		this.positionChanged.emit();
	}

	toggleFold(node: PlyNode): void {
		this.tree.toggleFold(node);
		this.positionChanged.emit();
	}

	readonly iconMenu = signal<OpenMenu | null>(null);

	readonly dropTarget = signal<MoveNode | null>(null);

	private dragIconNode: MoveNode | null = null;
	private dragStartX = 0;
	private dragStartY = 0;
	private dragMoved = false;
	private static readonly DRAG_THRESHOLD_PX = 5;

	onIconPointerDown(event: PointerEvent, node: MoveNode): void {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();

		this.dragIconNode = node;
		this.dragMoved = false;
		this.dragStartX = event.clientX;
		this.dragStartY = event.clientY;
		// Capturing on the icon itself, so the gesture survives leaving it.
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onIconDrag(event: PointerEvent, node: MoveNode): void {
		if (this.dragIconNode !== node) return;

		if (!this.dragMoved) {
			const dx = event.clientX - this.dragStartX;
			const dy = event.clientY - this.dragStartY;
			if (Math.hypot(dx, dy) <= MoveTreeComponent.DRAG_THRESHOLD_PX) return;
			this.dragMoved = true;
		}

		const found = this.resolveDropTarget(event.clientX, event.clientY);
		this.dropTarget.set(found && found !== node ? found : null);
	}

	private resolveDropTarget(x: number, y: number): MoveNode | null {
		const hit = document.elementFromPoint(x, y) as HTMLElement | null;
		const key = (hit?.closest('[data-node-key]') as HTMLElement | null)?.dataset['nodeKey'];
		if (key) {
			return this.keyToNode.get(key) ?? null;
		}
		return this.rootFromBlankSpace(hit, x, y);
	}

	private rootFromBlankSpace(hit: HTMLElement | null, x: number, y: number): MoveNode | null {
		const moves = this.host.nativeElement.querySelector('.moves');
		if (!moves || !hit || !moves.contains(hit)) {
			return null;
		}

		const first = moves.querySelector('.move-item');
		if (!first) {
			return this.tree.root();
		}

		const box = first.getBoundingClientRect();
		const beforeFirstMove = y < box.top || (y <= box.bottom && x < box.left);
		return beforeFirstMove ? this.tree.root() : null;
	}

	onIconPointerUp(event: PointerEvent, node: MoveNode): void {
		if (this.dragIconNode !== node) return;

		const target = this.dropTarget();
		const moved = this.dragMoved;
		this.dragIconNode = null;
		this.dragMoved = false;
		this.dropTarget.set(null);

		if (moved) {
			if (target) {
				this.tree.moveSolutionFold(node, target);
				this.positionChanged.emit();
			}
			return;
		}

		this.tree.toggleSolutionFold(node);
		this.positionChanged.emit();
	}

	onIconContextMenu(event: MouseEvent, node: MoveNode): void {
		event.preventDefault();
		event.stopPropagation();
		this.closeMenu();
		this.iconMenu.set({ node, anchor: (event.currentTarget as HTMLElement).getBoundingClientRect() });
	}

	closeIconMenu(): void {
		this.iconMenu.set(null);
	}

	iconMenuPosition(anchor: DOMRect): { x: number; y: number } {
		const width = 180;
		let x = anchor.right + 8;
		if (x + width > window.innerWidth) {
			x = anchor.left - width - 8;
		}
		x = Math.min(Math.max(x, 10), Math.max(10, window.innerWidth - width - 10));
		const y = Math.min(anchor.top, Math.max(10, window.innerHeight - 90));
		return { x, y };
	}

	addIconComment(node: MoveNode): void {
		this.closeIconMenu();
		this.startComment(node);
	}

	canRemoveIcon(node: MoveNode): boolean {
		return this.tree.canRemoveSolutionFold(node);
	}

	removeIcon(node: MoveNode): void {
		this.tree.removeSolutionFold(node);
		this.closeIconMenu();
		this.positionChanged.emit();
	}

	readonly editingNode = signal<MoveNode | null>(null);

	startComment(node: MoveNode): void {
		this.tree.beginComment(node);
		this.editingNode.set(node);
		this.closeMenu();

		afterNextRender(
			() => {
				const el = this.host.nativeElement.querySelector<HTMLElement>('.comment-text.editing');
				if (!el) return;
				el.textContent = node.comment ?? '';
				el.focus();
				const range = document.createRange();
				range.selectNodeContents(el);
				range.collapse(false);
				const selection = window.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
			},
			{ injector: this.injector },
		);
	}

	onCommentBlur(node: MoveNode, event: Event): void {
		this.tree.setComment(node, (event.target as HTMLElement).textContent ?? '');
		this.editingNode.set(null);
	}

	// A local trunk's model game lives in that same file, not on the server as a row id.
	openModelGame(game: RepertoireGame): void {
		const file = this.tree.repertoire()?.localCollectionId;
		const where = file
			? `local=${encodeURIComponent(`${file}#${game.itemId}`)}`
			: `item=${game.itemId}`;
		this.tabs.openElsewhere(`/analysis?${where}&ply=${game.ply}`);
	}

	protected readonly players = gamePlayers;

	when(game: RepertoireGame): string {
		return game.year ? String(game.year) : '';
	}

	details(game: RepertoireGame): string {
		const when = game.date ? formatGameDate(game.date.replace(/-/g, '.')) : '';
		const facts = [game.event, when, game.eco].filter((part) => part).join(' · ');
		return facts ? `${facts} — open on its own board` : 'Open this game on its own board';
	}

	openReportGame(game: ReportGame): void {
		this.tabs.openElsewhere(`/analysis?game=${game.id}&ply=${game.ply}`);
	}

	openBookFile(file: ReportBookFile, point: ReportPoint): void {
		const line = point.line.join(',');
		this.tabs.openElsewhere(`/analysis?item=${file.itemId}&line=${line}`);
	}

	protected readonly reportGameLabel = gameLabel;

	reportTag(point: ReportPoint, total: number): string {
		const kind = point.kind === 'DEVIATION' ? 'Deviation' : 'Overlap';
		return `${kind} ${point.index} / ${total}`;
	}

	isCurrentPoint(point: ReportPoint): boolean {
		return this.report.currentPoint() === point;
	}

	reportTotal(point: ReportPoint): number {
		return point.kind === 'DEVIATION' ? this.report.deviations().length : this.report.overlaps().length;
	}

	private scrollActiveIntoView(): void {
		// Scrolling out from under an open menu would leave it pointing at nothing.
		if (this.openMenu() || this.iconMenu()) return;

		const host = this.host.nativeElement as HTMLElement;
		const active = host.querySelector('.move-item.active') as HTMLElement | null;

		const target =
			(active?.closest('.move-wrapper') as HTMLElement | null) ??
			(host.querySelector('.report-point.current') as HTMLElement | null) ??
			active;

		if (!target) return;

		const container = scrollableAncestor(target);
		if (container) {
			scrollIntoContainer(container, target, { block: 'center', behavior: 'smooth' });
		}
	}
}
