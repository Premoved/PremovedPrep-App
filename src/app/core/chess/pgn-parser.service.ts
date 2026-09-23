import { Injectable } from '@angular/core';
import { Chess } from 'chess.js';
import { DrawShape } from '@lichess-org/chessground/draw';
import { Key } from '@lichess-org/chessground/types';
import { Color, PieceType, SquareName } from '../models/chess-enums';
import { MoveNode, PlyNode, RootNode, createRootNode } from '../models/move-node.model';
import { DEFAULT_FEN, activeColor } from './fen.util';
import { GameHeaders, gameHeadersFromTags } from './game-headers';
import { annotationFromNag, annotationFromSan } from './nag-codec';

export interface ParsedGame {
	readonly root: RootNode;
	readonly headers: GameHeaders;
}

const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '1/2', '*']);

const BRUSH_BY_CHESSBASE_COLOR: Readonly<Record<string, string>> = {
	G: 'green',
	R: 'red',
	B: 'blue',
	Y: 'yellow',
};

@Injectable({ providedIn: 'root' })
export class PgnParserService {
	parse(pgnText: string): ParsedGame {
		const tags = this.readTags(pgnText);
		const startFen = tags['FEN'] ?? DEFAULT_FEN;
		const root = createRootNode(startFen, activeColor(startFen));

		const movesBody = pgnText.replace(/^\[\w+\s+"[^"]*"\]\s*$/gm, '').trim();
		this.readSegment(movesBody.replace(/\s+/g, ' '), 0, root, startFen);
		return { root, headers: gameHeadersFromTags(tags) };
	}

	private readTags(pgnText: string): Record<string, string> {
		const tagPattern = /\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/g;
		const tags: Record<string, string> = {};
		let match: RegExpExecArray | null;
		while ((match = tagPattern.exec(pgnText)) !== null) {
			tags[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
		}
		return tags;
	}

	// Scans one parenthesis level and returns the index just past its closing ')'.
	private readSegment(text: string, startIndex: number, parentNode: MoveNode, fen: string): number {
		let i = startIndex;
		let lastNode: MoveNode = parentNode;
		const game = new Chess(fen);

		while (i < text.length) {
			const char = text[i];

			if (char === ' ') {
				i++;
				continue;
			}

			if (char === ')') {
				return i + 1;
			}

			if (char === '(') {
				// A variation replaces the last move played, so it branches from that move's parent.
				const branchPoint: MoveNode = lastNode.isRoot ? lastNode : lastNode.parent;
				i = this.readSegment(text, i + 1, branchPoint, branchPoint.fen);
				continue;
			}

			if (char === '{') {
				const end = text.indexOf('}', i);
				if (end !== -1) {
					this.applyComment(lastNode, text.substring(i + 1, end).trim());
					i = end + 1;
					continue;
				}
			}

			if (char === '$') {
				const nag = text.substring(i).match(/^\$(\d+)/);
				if (nag) {
					if (!lastNode.isRoot) {
						lastNode.annotation = annotationFromNag(nag[1]);
					}
					i += nag[0].length;
					continue;
				}
			}

			const moveToken = text.substring(i).match(/^(\d+\.{1,3}\s*)?([a-zA-Z0-9+#=!?-]+)/);
			if (moveToken) {
				const san = moveToken[2];
				if (!RESULT_TOKENS.has(san)) {
					const node = this.tryMove(game, san, lastNode);
					if (node) lastNode = node;
				}
				i += moveToken[0].length;
				continue;
			}

			i++;
		}

		return i;
	}

	private tryMove(game: Chess, san: string, parent: MoveNode): PlyNode | null {
		try {
			const move = game.move(san);
			const node: PlyNode = {
				isRoot: false,
				san: move.san,
				fen: game.fen(),
				color: move.color === 'w' ? Color.WHITE : Color.BLACK,
				piece: move.piece.toUpperCase() as PieceType,
				from: move.from as SquareName,
				to: move.to as SquareName,
				// Required here: the board suppresses its own move animation when this is set.
				promotion: move.promotion ? (move.promotion.toUpperCase() as PieceType) : undefined,
				parent,
				children: [],
				drawings: [],
				annotation: annotationFromSan(san),
			};
			parent.children.push(node);
			return node;
		} catch {
			return null;
		}
	}

	private applyComment(node: MoveNode, raw: string): void {
		const text = raw.replace(/\[%[^\]]+\]/g, '').trim();
		if (text) {
			node.comment = node.comment ? `${node.comment} ${text}` : text;
		}
		node.drawings = [...node.drawings, ...this.readDrawings(raw)];
	}

	private readDrawings(comment: string): DrawShape[] {
		const shapes: DrawShape[] = [];
		const pattern = /\[%(cal|csl)\s*([^\]]+)\]/gi;
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(comment)) !== null) {
			const kind = match[1].toLowerCase();

			for (const raw of match[2].split(',')) {
				const token = raw.trim();
				const brush = BRUSH_BY_CHESSBASE_COLOR[(token[0] ?? '').toUpperCase()] ?? 'green';

				if (kind === 'cal' && token.length >= 5) {
					shapes.push({ orig: token.substring(1, 3) as Key, dest: token.substring(3, 5) as Key, brush });
					continue;
				}

				if (kind === 'csl' && token.length >= 3) {
					const square = token.substring(1, 3) as Key;
					shapes.push({ orig: square, dest: square, brush });
				}
			}
		}

		return shapes;
	}
}
