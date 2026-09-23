import { beforeEach, describe, expect, it } from 'vitest';
import { DrawShape } from '@lichess-org/chessground/draw';
import { Annotation, Color, PieceType, SquareName } from '../../../core/models/chess-enums';
import { MoveTreeStore } from './move-tree.store';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const AFTER_D4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';

function ply(store: MoveTreeStore, san: string, fen: string, color = Color.WHITE) {
	return store.addMove({
		from: 'e2' as SquareName,
		to: 'e4' as SquareName,
		piece: PieceType.PAWN,
		color,
		san,
		fen,
	});
}

const ARROW: DrawShape = { orig: 'e2', dest: 'e4', brush: 'green' };

describe('MoveTreeStore', () => {
	let store: MoveTreeStore;

	beforeEach(() => {
		store = new MoveTreeStore();
		store.reset(START_FEN);
	});

	describe('initial state', () => {
		it('starts on the root', () => {
			expect(store.isAtRoot()).toBe(true);
			expect(store.currentNode()).toBe(store.root());
		});

		it('reads the side to move from the FEN', () => {
			store.reset('8/8/8/4k3/8/8/4K3/8 b - - 0 1');
			expect(store.root().color).toBe(Color.BLACK);
		});

		it('cannot go forward from an empty tree', () => {
			expect(store.canGoForward()).toBe(false);
		});

		it('hides drawings initially', () => {
			expect(store.drawingsVisible()).toBe(false);
			expect(store.visibleDrawings()).toEqual([]);
		});
	});

	describe('addMove', () => {
		it('appends a ply and moves onto it', () => {
			const node = ply(store, 'e4', AFTER_E4);
			expect(store.currentNode()).toBe(node);
			expect(store.root().children).toEqual([node]);
			expect(store.isAtRoot()).toBe(false);
		});

		it('reuses an existing child instead of duplicating a transposition', () => {
			const first = ply(store, 'e4', AFTER_E4);
			store.goToRoot();
			const second = ply(store, 'e4', AFTER_E4);
			expect(second).toBe(first);
			expect(store.root().children).toHaveLength(1);
		});

		it('keeps siblings when a different move is played from the same position', () => {
			ply(store, 'e4', AFTER_E4);
			store.goToRoot();
			ply(store, 'd4', AFTER_D4);
			expect(store.root().children.map((child) => child.san)).toEqual(['e4', 'd4']);
		});

		it('links the ply back to its parent', () => {
			const node = ply(store, 'e4', AFTER_E4);
			expect(node.isRoot).toBe(false);
			expect(node.parent).toBe(store.root());
		});
	});

	describe('canGoForward', () => {
		it('is true with a child ahead', () => {
			ply(store, 'e4', AFTER_E4);
			store.goToRoot();
			expect(store.canGoForward()).toBe(true);
		});

		it('becomes true when a drawing is added to a leaf and then hidden', () => {
			ply(store, 'e4', AFTER_E4);
			expect(store.canGoForward()).toBe(false);

			store.appendDrawings([ARROW]);
			expect(store.canGoForward()).toBe(false); // drawings are already visible

			store.setDrawingsVisible(false);
			expect(store.canGoForward()).toBe(true);
		});
	});

	describe('drawings as a navigation step', () => {
		beforeEach(() => {
			ply(store, 'e4', AFTER_E4);
			store.appendDrawings([ARROW]);
			ply(store, 'e5', AFTER_E4);
			store.goToRoot();
			store.goForward(); // onto e4, drawings hidden
		});

		it('reveals drawings before playing the next move', () => {
			expect(store.drawingsVisible()).toBe(false);

			expect(store.goForward()).toEqual({ kind: 'drawings' });
			expect(store.drawingsVisible()).toBe(true);
			expect(store.currentNode().san).toBe('e4');

			expect(store.goForward()).toEqual({ kind: 'moved' });
			expect(store.currentNode().san).toBe('e5');
		});

		it('hides drawings before leaving the move on the way back', () => {
			store.setDrawingsVisible(true);

			store.goBack();
			expect(store.drawingsVisible()).toBe(false);
			expect(store.currentNode().san).toBe('e4');

			store.goBack();
			expect(store.isAtRoot()).toBe(true);
		});

		it('reports the shapes only while they are visible', () => {
			expect(store.visibleDrawings()).toEqual([]);
			store.setDrawingsVisible(true);
			expect(store.visibleDrawings()).toEqual([ARROW]);
		});
	});

	describe('goForward', () => {
		it('reports a branch instead of guessing', () => {
			ply(store, 'e4', AFTER_E4);
			store.goToRoot();
			ply(store, 'd4', AFTER_D4);
			store.goToRoot();

			const step = store.goForward();
			expect(step.kind).toBe('branch');
			expect(step.kind === 'branch' && step.variations.map((node) => node.san)).toEqual(['e4', 'd4']);
			expect(store.isAtRoot()).toBe(true);
		});

		it('reports nothing to do at a leaf with visible drawings', () => {
			ply(store, 'e4', AFTER_E4);
			store.setDrawingsVisible(true);
			expect(store.goForward()).toEqual({ kind: 'none' });
		});
	});

	describe('goBack at the root', () => {
		it('stays put and hides drawings', () => {
			store.setDrawingsVisible(true);
			store.goBack();
			expect(store.isAtRoot()).toBe(true);
			expect(store.drawingsVisible()).toBe(false);
		});
	});

	describe('goToLast', () => {
		it('follows the first child at every branch', () => {
			ply(store, 'e4', AFTER_E4);
			ply(store, 'e5', AFTER_D4);
			store.goToRoot();
			ply(store, 'd4', AFTER_D4); // sibling of e4, must be ignored

			store.goToRoot();
			store.goToLast();
			expect(store.currentNode().san).toBe('e5');
			expect(store.drawingsVisible()).toBe(false);
		});

		it('is a no-op on a leaf', () => {
			const node = ply(store, 'e4', AFTER_E4);
			store.goToLast();
			expect(store.currentNode()).toBe(node);
		});
	});

	describe('replaceDrawings', () => {
		const CIRCLE: DrawShape = { orig: 'd4', dest: 'd4', brush: 'blue' };

		it('replaces the list while the drawings are on screen', () => {
			ply(store, 'e4', AFTER_E4);
			store.replaceDrawings([ARROW]);
			expect(store.drawingsVisible()).toBe(true);

			expect(store.replaceDrawings([CIRCLE])).toEqual([CIRCLE]);
		});

		it('merges instead, when they were hidden', () => {
			const node = ply(store, 'e4', AFTER_E4);
			store.replaceDrawings([ARROW]);
			store.goBack();
			store.select(node);
			expect(store.drawingsVisible()).toBe(false);

			expect(store.replaceDrawings([CIRCLE])).toEqual([ARROW, CIRCLE]);
			expect(store.drawingsVisible()).toBe(true);
		});

		it('does not merge a node with no drawings yet', () => {
			ply(store, 'e4', AFTER_E4);
			expect(store.replaceDrawings([ARROW])).toEqual([ARROW]);
		});
	});

	describe('editing', () => {
		it('setComment stores trimmed text and clears on blank', () => {
			const node = ply(store, 'e4', AFTER_E4);
			store.setComment(node, '  a strong centre  ');
			expect(node.comment).toBe('a strong centre');

			store.setComment(node, '   ');
			expect(node.comment).toBeUndefined();
		});

		it('beginComment opens an empty comment without overwriting an existing one', () => {
			const node = ply(store, 'e4', AFTER_E4);
			store.beginComment(node);
			expect(node.comment).toBe('');

			store.setComment(node, 'kept');
			store.beginComment(node);
			expect(node.comment).toBe('kept');
		});

		it('setAnnotation sets and clears', () => {
			const node = ply(store, 'e4', AFTER_E4);
			store.setAnnotation(node, Annotation.BRILLIANT_MOVE);
			expect(node.annotation).toBe(Annotation.BRILLIANT_MOVE);

			store.setAnnotation(node, undefined);
			expect(node.annotation).toBeUndefined();
		});

		it('clearDrawings empties a node and re-evaluates canGoForward', () => {
			const node = ply(store, 'e4', AFTER_E4);
			store.appendDrawings([ARROW]);
			store.setDrawingsVisible(false);
			expect(store.canGoForward()).toBe(true);

			store.clearDrawings(node);
			expect(node.drawings).toEqual([]);
			expect(store.canGoForward()).toBe(false);
		});
	});

	describe('deleteNode', () => {
		it('removes the ply from its parent', () => {
			const e4 = ply(store, 'e4', AFTER_E4);
			store.goToRoot();
			const d4 = ply(store, 'd4', AFTER_D4);

			store.deleteNode(e4);
			expect(store.root().children).toEqual([d4]);
		});

		it('retreats the cursor when it is inside the deleted subtree', () => {
			const e4 = ply(store, 'e4', AFTER_E4);
			ply(store, 'e5', 'after-e5', Color.BLACK);

			store.deleteNode(e4);
			expect(store.currentNode()).toBe(store.root());
			expect(store.drawingsVisible()).toBe(false);
		});

		it('leaves the cursor alone when it is on another branch', () => {
			ply(store, 'e4', AFTER_E4);
			store.goToRoot();
			const d4 = ply(store, 'd4', AFTER_D4);

			store.deleteNode(store.root().children[0]);
			expect(store.currentNode()).toBe(d4);
		});
	});

	describe('promoteLine', () => {
		it('moves a side line to the front of its own parent', () => {
			const e4 = ply(store, 'e4', AFTER_E4);
			store.goToRoot();
			const d4 = ply(store, 'd4', AFTER_D4);

			store.promoteLine(d4);
			expect(store.root().children).toEqual([d4, e4]);
		});

		it('promotes every ancestor, so a nested side line becomes the mainline', () => {
			const e4 = ply(store, 'e4', AFTER_E4);
			store.goToRoot();
			const d4 = ply(store, 'd4', AFTER_D4);
			const d5 = ply(store, 'd5', 'after-d5', Color.BLACK);
			store.select(d4);
			const nf6 = ply(store, 'Nf6', 'after-nf6', Color.BLACK);

			store.promoteLine(nf6);

			expect(d4.children).toEqual([nf6, d5]);
			expect(store.root().children).toEqual([d4, e4]);
		});
	});

	describe('reset and adopt', () => {
		it('reset discards the tree', () => {
			ply(store, 'e4', AFTER_E4);
			store.reset(START_FEN);
			expect(store.isAtRoot()).toBe(true);
			expect(store.root().children).toEqual([]);
			expect(store.canGoForward()).toBe(false);
		});

		it('adopt takes an external tree and parks on its root', () => {
			const other = new MoveTreeStore();
			other.reset(START_FEN);
			ply(other, 'e4', AFTER_E4);

			store.setDrawingsVisible(true);
			store.adopt(other.root());

			expect(store.root()).toBe(other.root());
			expect(store.isAtRoot()).toBe(true);
			expect(store.drawingsVisible()).toBe(false);
			expect(store.canGoForward()).toBe(true);
		});
	});
});
