import { Injectable } from '@angular/core';
import { DrawShape } from '@lichess-org/chessground/draw';
import { Color } from '../models/chess-enums';
import { MoveNode, PlyNode, RootNode } from '../models/move-node.model';
import { fullmoveField } from './fen.util';
import { nagFromAnnotation } from './nag-codec';

@Injectable({ providedIn: 'root' })
export class PgnSerializerService {
	// Movetext with just enough header to be parsed back; not the export format (composePgnFile is).
	// Kept because round-trip tests need a parseable string and nothing else.
	serialize(root: RootNode | null): string {
		if (!root) return '';

		const header = `[FEN "${root.fen}"]\n[Variant "From Position"]\n\n`;
		return (header + this.buildLine(root)).replace(/\s+/g, ' ').trim() + ' *';
	}

	movetext(root: RootNode | null): string {
		if (!root) return '';
		return this.buildLine(root).replace(/\s+/g, ' ').trim() + ' *';
	}

	private buildLine(node: MoveNode): string {
		if (node.isRoot) {
			const first = realChildren(node)[0];
			return first ? this.buildLine(first) : '';
		}

		const parent = node.parent;
		const siblings = realChildren(parent);
		let out = '';

		const moveNumber = fullmoveField(parent.fen);
		if (node.color === Color.WHITE) {
			out += `${moveNumber}. `;
		} else if (siblings[0] !== node || parent.isRoot) {
			out += `${moveNumber}... `;
		}

		out += node.san;

		if (node.annotation) {
			const nag = nagFromAnnotation(node.annotation);
			if (nag) out += ` $${nag}`;
		}

		out += ' ';
		out += this.buildCommentBlock(node);

		if (siblings.length > 1 && siblings[0] === node) {
			for (let i = 1; i < siblings.length; i++) {
				out += `(${this.buildLine(siblings[i])}) `;
			}
		}

		const continuations = realChildren(node);
		if (continuations.length > 0) {
			out += this.buildLine(continuations[0]);
		}

		return out;
	}

	private buildCommentBlock(node: MoveNode): string {
		const comment = node.comment?.trim() ?? '';
		const drawings = node.drawings;
		if (!comment && drawings.length === 0) return '';

		let out = '{ ';

		if (drawings.length > 0) {
			const circles = drawings
				.filter((shape) => !shape.dest || shape.orig === shape.dest)
				.map((shape) => `${chessBaseColor(shape)}${shape.orig}`)
				.filter((token) => token.length > 1)
				.join(',');

			const arrows = drawings
				.filter((shape) => shape.dest && shape.orig !== shape.dest)
				.map((shape) => `${chessBaseColor(shape)}${shape.orig}${shape.dest}`)
				.join(',');

			if (circles) out += `[%csl ${circles}] `;
			if (arrows) out += `[%cal ${arrows}] `;
		}

		if (comment) out += `${comment} `;

		return out + '} ';
	}
}

// A node's children with repertoire-grafted branches removed.
function realChildren(node: MoveNode): PlyNode[] {
	return node.children.filter((child) => !child.generated);
}

function chessBaseColor(shape: DrawShape): string {
	const brush = shape.brush?.toLowerCase() ?? '';
	if (brush.includes('green')) return 'G';
	if (brush.includes('red')) return 'R';
	if (brush.includes('blue')) return 'B';
	return 'Y';
}
