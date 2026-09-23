import { Injectable, computed, signal } from '@angular/core';
import { Chess } from 'chess.js';
import { DrawShape } from '@lichess-org/chessground/draw';
import { DEFAULT_FEN, activeColor } from '../../../core/chess/fen.util';
import { GameHeaders, NO_GAME_HEADERS } from '../../../core/chess/game-headers';
import { Annotation, Color, PieceType, SquareName } from '../../../core/models/chess-enums';
import { MoveNode, PlyNode, RootNode, createRootNode } from '../../../core/models/move-node.model';
import { RepertoireBranch, RepertoireTree } from '../../../core/models/repertoire.model';
import { parseUci, uciOf } from '../../../core/chess/uci-notation';

export interface MoveInput {
	from: SquareName;
	to: SquareName;
	piece: PieceType;
	color: Color;
	san: string;
	fen: string;
	promotion?: PieceType;
}

const DECIDED_RESULTS: ReadonlySet<string> = new Set(['1-0', '0-1', '1/2-1/2']);

export type ForwardStep =
	{ kind: 'none' } | { kind: 'drawings' } | { kind: 'moved' } | { kind: 'branch'; variations: PlyNode[] };

/** Analysis tree and cursor. Nodes mutate in place; views subscribe to `revision`. */
@Injectable()
export class MoveTreeStore {
	private readonly _root = signal<RootNode>(createRootNode(DEFAULT_FEN, Color.WHITE));
	private readonly _currentNode = signal<MoveNode>(this._root());
	private readonly _drawingsVisible = signal(false);

	private readonly _headers = signal<GameHeaders>(NO_GAME_HEADERS);

	// Bumped whenever the tree is mutated in place.
	private readonly _revision = signal(0);

	private readonly _savedRevision = signal(0);

	private readonly _isStudy = signal(false);

	private readonly _repertoire = signal<RepertoireTree | null>(null);

	readonly root = this._root.asReadonly();
	readonly currentNode = this._currentNode.asReadonly();
	readonly drawingsVisible = this._drawingsVisible.asReadonly();
	readonly headers = this._headers.asReadonly();
	readonly isStudy = this._isStudy.asReadonly();
	readonly repertoire = this._repertoire.asReadonly();

	setStudy(isStudy: boolean): void {
		this._isStudy.set(isStudy);
		if (isStudy && !this.hasAnySolutionFold()) {
			this._root().solutionFold = 'collapsed';
		}
		this._revision.update((value) => value + 1);
	}

	readonly revision = this._revision.asReadonly();

	readonly isDirty = computed(() => this._revision() !== this._savedRevision());

	markSaved(): void {
		this._savedRevision.set(this._revision());
	}

	// Forces isDirty() without mutating the tree, so a restored draft is not read as saved.
	markDirty(): void {
		this._revision.update((value) => value + 1);
	}

	readonly isAtRoot = computed(() => this._currentNode().isRoot);

	readonly canGoForward = computed(() => {
		this._revision();
		const node = this._currentNode();
		// A collapsed solution boundary blocks forward movement.
		if (node.solutionFold === 'collapsed') return false;
		if (node.drawings.length > 0 && !this._drawingsVisible()) return true;
		return node.children.length > 0;
	});

	readonly solutionHiddenAtCurrent = computed(() => {
		this._revision();
		return this._currentNode().solutionFold === 'collapsed';
	});

	visibleDrawings(): DrawShape[] {
		return this._drawingsVisible() ? this._currentNode().drawings : [];
	}

	reset(fen: string): void {
		const root = createRootNode(fen, activeColor(fen));
		if (this._isStudy()) {
			root.solutionFold = 'collapsed';
		}
		this._root.set(root);
		this._currentNode.set(root);
		this._headers.set(NO_GAME_HEADERS);
		this._repertoire.set(null);
		this._revision.update((value) => value + 1);
		this.markSaved();
	}

	adopt(root: RootNode, headers: GameHeaders = NO_GAME_HEADERS, isStudy = false): void {
		this._root.set(root);
		this._currentNode.set(root);
		this._drawingsVisible.set(false);
		this._repertoire.set(null);
		this._headers.set(headers);
		this.writeResultComment(root, headers.result);
		this.setStudy(isStudy);
		this._revision.update((value) => value + 1);
		this.markSaved();
	}

	setHeaders(headers: GameHeaders): void {
		this._headers.set(headers);
		this._revision.update((value) => value + 1);
	}

	private writeResultComment(root: RootNode, result: string | undefined): void {
		if (!result || !DECIDED_RESULTS.has(result.trim())) {
			return;
		}

		let last: MoveNode = root;
		while (last.children.length > 0) {
			last = last.children[0];
		}
		if (last.isRoot) {
			return;
		}

		last.comment = last.comment ? `${last.comment} ${result}` : result;
	}

	addMove(move: MoveInput): PlyNode {
		const parent = this._currentNode();
		const existing = parent.children.find((child) => child.fen === move.fen);

		if (existing) {
			this.setCurrent(existing);
			return existing;
		}

		const node: PlyNode = {
			isRoot: false,
			parent,
			san: move.san,
			color: move.color,
			piece: move.piece,
			from: move.from,
			to: move.to,
			promotion: move.promotion,
			fen: move.fen,
			children: [],
			drawings: [],
		};

		parent.children.push(node);
		// Writing a move under a suggested one accepts the suggestion.
		this.promoteGenerated(parent);
		this.setCurrent(node);
		this._revision.update((value) => value + 1);
		return node;
	}

	applyRepertoireTree(tree: RepertoireTree | null): void {
		const wasDirty = this.isDirty();

		this.clearGenerated();
		this._repertoire.set(tree);

		for (const attachment of tree?.attachments ?? []) {
			const anchor = this.resolvePath(attachment.path);
			if (!anchor) continue;

			if (attachment.games.length > 0) {
				anchor.modelGames = attachment.games;
			}
			this.graft(anchor, attachment.branches);
		}

		this._revision.update((value) => value + 1);
		if (!wasDirty) {
			this.markSaved();
		}
	}

	private clearGenerated(): void {
		if (this.isAtOrBelowGenerated()) {
			let cursor: MoveNode = this._currentNode();
			while (!cursor.isRoot && this.hasGeneratedAncestorOrSelf(cursor)) {
				cursor = cursor.parent;
			}
			this._currentNode.set(cursor);
			this._drawingsVisible.set(false);
		}

		this.walk(this._root(), (node) => {
			node.modelGames = undefined;
			node.children = node.children.filter((child) => !child.generated);
		});
	}

	private hasGeneratedAncestorOrSelf(node: MoveNode): boolean {
		for (let cursor: MoveNode = node; !cursor.isRoot; cursor = cursor.parent) {
			if (cursor.generated) return true;
		}
		return false;
	}

	private isAtOrBelowGenerated(): boolean {
		return this.hasGeneratedAncestorOrSelf(this._currentNode());
	}

	private resolvePath(path: readonly string[]): MoveNode | null {
		let node: MoveNode = this._root();
		for (const uci of path) {
			const child: PlyNode | undefined = node.children.find((candidate) => uciOf(candidate) === uci);
			if (!child) return null;
			node = child;
		}
		return node;
	}

	private graft(parent: MoveNode, branches: readonly RepertoireBranch[]): void {
		for (const branch of branches) {
			const node = this.generatedChild(parent, branch.uci);
			if (!node) continue;

			if (branch.games.length > 0) {
				node.modelGames = branch.games;
			}
			this.graft(node, branch.children);
		}
	}

	private generatedChild(parent: MoveNode, uci: string): PlyNode | null {
		const existing = parent.children.find((child) => uciOf(child) === uci);
		if (existing) {
			return existing;
		}

		const move = parseUci(uci);
		if (!move) return null;

		try {
			const game = new Chess(parent.fen);
			const played = game.move({ from: move.from, to: move.to, promotion: move.promotion });
			const node: PlyNode = {
				isRoot: false,
				parent,
				san: played.san,
				color: played.color === 'w' ? Color.WHITE : Color.BLACK,
				piece: played.piece.toUpperCase() as PieceType,
				from: played.from as SquareName,
				to: played.to as SquareName,
				promotion: played.promotion ? (played.promotion.toUpperCase() as PieceType) : undefined,
				fen: game.fen(),
				children: [],
				drawings: [],
				generated: true,
			};
			parent.children.push(node);
			return node;
		} catch {
			return null;
		}
	}

	private promoteGenerated(node: MoveNode): void {
		let changed = false;
		for (let cursor: MoveNode = node; !cursor.isRoot; cursor = cursor.parent) {
			if (cursor.generated) {
				cursor.generated = undefined;
				changed = true;
			}
		}
		if (changed) {
			this._revision.update((value) => value + 1);
		}
	}

	setDrawingsVisible(visible: boolean): void {
		this._drawingsVisible.set(visible);
	}

	replaceDrawings(shapes: DrawShape[]): DrawShape[] {
		const node = this._currentNode();
		this.promoteGenerated(node);
		node.drawings = this._drawingsVisible() ? [...shapes] : [...node.drawings, ...shapes];
		this._drawingsVisible.set(true);
		this._revision.update((value) => value + 1);
		return node.drawings;
	}

	appendDrawings(shapes: DrawShape[]): DrawShape[] {
		const node = this._currentNode();
		this.promoteGenerated(node);
		node.drawings = [...node.drawings, ...shapes];
		this._drawingsVisible.set(true);
		this._revision.update((value) => value + 1);
		return node.drawings;
	}

	setAnnotation(node: MoveNode, annotation: Annotation | undefined): void {
		this.promoteGenerated(node);
		node.annotation = annotation;
		this._revision.update((value) => value + 1);
	}

	beginComment(node: MoveNode): void {
		if (node.comment === undefined) {
			this.promoteGenerated(node);
			node.comment = '';
			this._revision.update((value) => value + 1);
		}
	}

	setComment(node: MoveNode, comment: string): void {
		this.promoteGenerated(node);
		const trimmed = comment.trim();
		node.comment = trimmed === '' ? undefined : trimmed;
		this._revision.update((value) => value + 1);
	}

	clearDrawings(node: MoveNode): void {
		node.drawings = [];
		this._revision.update((value) => value + 1);
	}

	deleteNode(node: PlyNode): void {
		const parent = node.parent;
		parent.children = parent.children.filter((child) => child !== node);

		if (this.isAtOrBelow(node)) {
			this.setCurrent(parent);
			this._drawingsVisible.set(false);
		}

		// Deleting a branch can take every solution boundary with it.
		if (this._isStudy() && !this.hasAnySolutionFold()) {
			this._root().solutionFold = 'collapsed';
		}

		this._revision.update((value) => value + 1);
	}

	promoteLine(node: PlyNode): void {
		this.promoteGenerated(node);
		let child: MoveNode = node;
		let parent: MoveNode | null = node.parent;

		while (parent) {
			const index = parent.children.findIndex((candidate) => candidate === child);
			if (index > 0) {
				const [promoted] = parent.children.splice(index, 1);
				parent.children.unshift(promoted);
			}
			child = parent;
			parent = parent.isRoot ? null : parent.parent;
		}

		this._revision.update((value) => value + 1);
	}

	private isAtOrBelow(node: MoveNode): boolean {
		let cursor: MoveNode | null = this._currentNode();
		while (cursor) {
			if (cursor === node) return true;
			cursor = cursor.isRoot ? null : cursor.parent;
		}
		return false;
	}

	insertFoldingPoint(node: PlyNode): void {
		this.collapse(node);
	}

	removeFoldingPoint(node: PlyNode): void {
		node.fold = undefined;
		this._revision.update((value) => value + 1);
	}

	toggleFold(node: PlyNode): void {
		if (node.fold === undefined) return;

		if (node.fold === 'collapsed') {
			node.fold = 'expanded';
			this._revision.update((value) => value + 1);
			return;
		}

		this.collapse(node);
	}

	private collapse(node: PlyNode): void {
		node.fold = 'collapsed';

		if (this._currentNode() !== node && this.isAtOrBelow(node)) {
			this._currentNode.set(node);
			this._drawingsVisible.set(false);
		}

		this._revision.update((value) => value + 1);
	}

	private walk(node: MoveNode, visit: (node: MoveNode) => void): void {
		visit(node);
		for (const child of node.children) {
			this.walk(child, visit);
		}
	}

	private hasAnySolutionFold(): boolean {
		let found = false;
		this.walk(this._root(), (node) => {
			if (node.solutionFold !== undefined) found = true;
		});
		return found;
	}

	private countSolutionFolds(): number {
		let count = 0;
		this.walk(this._root(), (node) => {
			if (node.solutionFold !== undefined) count++;
		});
		return count;
	}

	canRemoveSolutionFold(node: MoveNode): boolean {
		return node.solutionFold !== undefined && this.countSolutionFolds() > 1;
	}

	insertSolutionFold(node: MoveNode): void {
		this.collapseSolution(node);
	}

	removeSolutionFold(node: MoveNode): void {
		if (!this.canRemoveSolutionFold(node)) return;
		node.solutionFold = undefined;
		this._revision.update((value) => value + 1);
	}

	toggleSolutionFold(node: MoveNode): void {
		if (node.solutionFold === undefined) return;

		if (node.solutionFold === 'collapsed') {
			node.solutionFold = 'expanded';
			this._revision.update((value) => value + 1);
			return;
		}

		this.collapseSolution(node);
	}

	moveSolutionFold(from: MoveNode, to: MoveNode): void {
		if (from === to || from.solutionFold === undefined) return;

		const state = from.solutionFold;
		from.solutionFold = undefined;
		to.solutionFold = state;

		if (state === 'collapsed' && this._currentNode() !== to && this.isAtOrBelow(to)) {
			this._currentNode.set(to);
			this._drawingsVisible.set(false);
		}

		this._revision.update((value) => value + 1);
	}

	private collapseSolution(node: MoveNode): void {
		node.solutionFold = 'collapsed';

		if (this._currentNode() !== node && this.isAtOrBelow(node)) {
			this._currentNode.set(node);
			this._drawingsVisible.set(false);
		}

		this._revision.update((value) => value + 1);
	}

	private setCurrent(node: MoveNode): void {
		this._currentNode.set(node);
		this.revealPathTo(node);
	}

	private revealPathTo(node: MoveNode): void {
		let changed = false;
		let cursor: MoveNode = node;

		while (!cursor.isRoot) {
			cursor = cursor.parent;
			if (!cursor.isRoot && cursor.fold === 'collapsed') {
				cursor.fold = 'expanded';
				changed = true;
			}
		}

		if (changed) {
			this._revision.update((value) => value + 1);
		}
	}

	select(node: MoveNode): void {
		this.setCurrent(node);
		this._drawingsVisible.set(false);
	}

	goToMainlinePly(ply: number): void {
		let node: MoveNode = this._root();
		for (let step = 0; step < ply && node.children.length > 0; step++) {
			if (node.solutionFold === 'collapsed') {
				break;
			}
			node = node.children[0];
		}
		this.setCurrent(node);
		this._drawingsVisible.set(false);
	}

	goToLine(line: readonly string[]): void {
		let node: MoveNode = this._root();
		for (const uci of line) {
			if (node.solutionFold === 'collapsed') {
				break;
			}
			const child: PlyNode | undefined = node.children.find((candidate) => uciOf(candidate) === uci);
			if (!child) {
				break;
			}
			node = child;
		}
		this.setCurrent(node);
		this._drawingsVisible.set(false);
	}

	goToRoot(): void {
		this.setCurrent(this._root());
		this._drawingsVisible.set(false);
	}

	goToLast(): void {
		let node: MoveNode = this._currentNode();
		while (node.solutionFold !== 'collapsed' && node.children.length > 0) {
			node = node.children[0];
		}
		this.setCurrent(node);
		this._drawingsVisible.set(false);
	}

	goBack(): void {
		const node = this._currentNode();

		if (node.isRoot) {
			this._drawingsVisible.set(false);
			return;
		}

		// Hide the drawings first; the next press leaves the move.
		if (node.drawings.length > 0 && this._drawingsVisible()) {
			this._drawingsVisible.set(false);
			return;
		}

		this.setCurrent(node.parent);
		this._drawingsVisible.set(false);
	}

	goForward(): ForwardStep {
		const node = this._currentNode();

		if (node.solutionFold === 'collapsed') {
			return { kind: 'none' };
		}

		if (node.children.length === 0) {
			if (this._drawingsVisible()) return { kind: 'none' };
			this._drawingsVisible.set(true);
			return { kind: 'drawings' };
		}

		if (node.drawings.length > 0 && !this._drawingsVisible()) {
			this._drawingsVisible.set(true);
			return { kind: 'drawings' };
		}

		if (node.children.length === 1) {
			this.select(node.children[0]);
			return { kind: 'moved' };
		}

		return { kind: 'branch', variations: node.children };
	}
}
