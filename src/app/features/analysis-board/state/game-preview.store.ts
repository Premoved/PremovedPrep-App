import { Injectable, computed, inject, signal } from '@angular/core';
import { PgnParserService } from '../../../core/chess/pgn-parser.service';
import { GameSummary } from '../../../core/models/game-list.model';
import { MoveNode, RootNode } from '../../../core/models/move-node.model';
import { OpeningExplorerService } from '../../../core/services/opening-explorer.service';
import { MoveTreeStore } from './move-tree.store';

@Injectable()
export class GamePreviewStore {
	private readonly api = inject(OpeningExplorerService);
	private readonly pgn = inject(PgnParserService);

	private readonly _game = signal<GameSummary | null>(null);
	private readonly _tree = signal<MoveTreeStore | null>(null);

	private rows: readonly GameSummary[] = [];

	// Monotonic; only the newest fetch may install a tree.
	private requestId = 0;

	readonly game = this._game.asReadonly();

	readonly tree = this._tree.asReadonly();

	readonly isActive = computed(() => this._game() !== null);

	setRows(rows: readonly GameSummary[]): void {
		this.rows = rows;
	}

	select(game: GameSummary): void {
		if (this._game()?.id === game.id) return;

		// Set before the fetch so the row highlights immediately.
		const id = ++this.requestId;
		this._game.set(game);

		this.api.game(game.id).subscribe({
			next: (detail) => {
				if (id !== this.requestId) return;
				this.build(detail.pgn, game.ply);
			},
			error: () => {
				if (id !== this.requestId) return;
				this.clear();
			},
		});
	}

	clear(): void {
		if (this._game() === null && this._tree() === null) return;

		this.requestId++;
		this._game.set(null);
		this._tree.set(null);
	}

	selectPrevious(): void {
		this.step(-1);
	}

	selectNext(): void {
		this.step(1);
	}

	private step(delta: number): void {
		const current = this._game();
		if (!current) return;

		const index = this.rows.findIndex((row) => row.id === current.id);
		if (index < 0) return;

		const next = index + delta;
		if (next < 0 || next >= this.rows.length) return;

		this.select(this.rows[next]);
	}

	private build(pgn: string, ply: number): void {
		const tree = new MoveTreeStore();

		try {
			const parsed = this.pgn.parse(pgn);
			tree.adopt(parsed.root, parsed.headers);
			tree.select(nodeAtPly(parsed.root, ply));
		} catch {
			this.clear();
			return;
		}

		this._tree.set(tree);
	}
}

function nodeAtPly(root: RootNode, ply: number): MoveNode {
	let node: MoveNode = root;
	for (let i = 0; i < ply && node.children.length > 0; i++) {
		node = node.children[0];
	}
	return node;
}
