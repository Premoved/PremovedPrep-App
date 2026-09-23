import { Injectable, computed, inject, signal } from '@angular/core';
import { Chess } from 'chess.js';
import { DrawShape } from '@lichess-org/chessground/draw';
import { Key } from '@lichess-org/chessground/types';
import { DEFAULT_FEN, activeColor } from '../../../core/chess/fen.util';
import { parseUci } from '../../../core/chess/uci-notation';
import { Color, PieceType, SquareName } from '../../../core/models/chess-enums';
import { MoveNode, PlyNode, createRootNode } from '../../../core/models/move-node.model';
import { AdvancedReport, ReportNode, ReportPoint, ReportPointKind } from '../../../core/models/report.model';
import { MoveTreeStore } from './move-tree.store';

export interface ReportEndpoint {
	readonly node: MoveNode;
	readonly point: ReportPoint;
}

@Injectable()
export class ReportStore {
	private readonly tree = inject(MoveTreeStore);

	private readonly _report = signal<AdvancedReport | null>(null);
	private readonly _overlaps = signal<readonly ReportEndpoint[]>([]);
	private readonly _deviations = signal<readonly ReportEndpoint[]>([]);

	// Where the reader is among each kind, 0-based, or -1 for not on one.
	private readonly _overlapAt = signal(-1);
	private readonly _deviationAt = signal(-1);

	readonly report = this._report.asReadonly();
	readonly overlaps = this._overlaps.asReadonly();
	readonly deviations = this._deviations.asReadonly();

	readonly hasReport = computed(() => this._report() !== null);

	readonly overlapLabel = computed(() => label(this._overlapAt(), this._overlaps().length));
	readonly deviationLabel = computed(() => label(this._deviationAt(), this._deviations().length));

	readonly currentPoint = computed<ReportPoint | null>(() => {
		this.tree.revision();
		return this.tree.currentNode().reportPoint ?? null;
	});

	readonly boardShapes = computed<DrawShape[]>(() => {
		this.tree.revision();
		const node = this.tree.currentNode();

		// Trunk: repertoire moves actually played by the opponent. Moves the reader adds while
		// reading have no reportGames and are excluded.
		const trunk = node.children
			.filter((child) => child.reportGames !== undefined)
			.map((child) => ({ orig: child.from as Key, dest: child.to as Key, brush: 'reportTrunk' }));

		const point = node.reportPoint ?? null;
		if (!point) {
			return trunk;
		}

		const brush = point.kind === 'DEVIATION' ? 'reportDeviation' : 'reportOverlap';
		const coloured = point.moves
			.map((move) => parseUci(move.uci))
			.filter((move): move is { from: string; to: string; promotion?: string } => move !== null)
			.map((move) => ({ orig: move.from as Key, dest: move.to as Key, brush }));

		// Trunk first, so a coloured arrow is drawn over a grey one where the two share a square.
		return [...trunk, ...coloured];
	});

	build(report: AdvancedReport | null): void {
		this._report.set(report);
		this._overlapAt.set(-1);
		this._deviationAt.set(-1);

		if (!report) {
			this._overlaps.set([]);
			this._deviations.set([]);
			this.tree.reset(DEFAULT_FEN);
			return;
		}

		const root = createRootNode(DEFAULT_FEN, activeColor(DEFAULT_FEN));
		const overlaps: ReportEndpoint[] = [];
		const deviations: ReportEndpoint[] = [];

		attach(root, report.root, overlaps, deviations);

		this._overlaps.set(overlaps);
		this._deviations.set(deviations);
		this.tree.adopt(root);
	}

	step(kind: ReportPointKind, delta: number): MoveNode | null {
		const list = kind === 'OVERLAP' ? this._overlaps() : this._deviations();
		if (list.length === 0) {
			return null;
		}
		const forward = delta >= 0;
		const at = kind === 'OVERLAP' ? this._overlapAt() : this._deviationAt();
		// From nowhere, Next goes to the first and Previous to the last.
		const next = at < 0 ? (forward ? 0 : list.length - 1) : (at + (forward ? 1 : -1) + list.length) % list.length;

		if (kind === 'OVERLAP') {
			this._overlapAt.set(next);
		} else {
			this._deviationAt.set(next);
		}
		return list[next].node;
	}

	syncToCursor(): void {
		const node = this.tree.currentNode();
		const point = node.reportPoint;
		if (!point) {
			return;
		}
		const list = point.kind === 'OVERLAP' ? this._overlaps() : this._deviations();
		const at = list.findIndex((endpoint) => endpoint.node === node);
		if (at < 0) {
			return;
		}
		if (point.kind === 'OVERLAP') {
			this._overlapAt.set(at);
		} else {
			this._deviationAt.set(at);
		}
	}
}

function label(at: number, total: number): string {
	return `${at < 0 ? '–' : at + 1} / ${total}`;
}

function attach(parent: MoveNode, source: ReportNode, overlaps: ReportEndpoint[], deviations: ReportEndpoint[]): void {
	if (source.point) {
		const point = spell(source.point, parent.fen);
		parent.reportPoint = point;
		(point.kind === 'OVERLAP' ? overlaps : deviations).push({ node: parent, point });
	}

	for (const child of source.children) {
		const node = play(parent, child.uci);
		if (node) {
			// The mark that separates a move the overlay found from one the reader played.
			node.reportGames = child.games;
			attach(node, child, overlaps, deviations);
		}
	}
}

function spell(point: ReportPoint, fen: string): ReportPoint {
	let changed = false;
	const moves = point.moves.map((move) => {
		const parsed = parseUci(move.uci);
		if (!parsed) {
			return move;
		}
		try {
			const game = new Chess(fen);
			const played = game.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion });
			if (played.san === move.san) {
				return move;
			}
			changed = true;
			return { ...move, san: played.san };
		} catch {
			return move;
		}
	});
	return changed ? { ...point, moves } : point;
}

function play(parent: MoveNode, uci: string | null): PlyNode | null {
	const move = uci ? parseUci(uci) : null;
	if (!move) {
		return null;
	}
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
		};
		parent.children.push(node);
		return node;
	} catch {
		return null;
	}
}
