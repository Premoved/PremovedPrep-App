import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { activeColor } from '../../../../core/chess/fen.util';
import { UciMove, parseUciMove } from '../../../../core/engine/uci';
import { Color } from '../../../../core/models/chess-enums';
import { OpeningTreeMove, TopGame } from '../../../../core/models/opening-tree.model';
import { OpeningExplorerStore } from '../../state/opening-explorer.store';

interface ReferenceGame {
	readonly white: string;
	readonly black: string;
	readonly whiteIsMover: boolean;
	readonly tail: string;
	readonly engine: boolean;
}

interface RenderedMove {
	readonly san: string;
	readonly count: string;
	readonly white: number;
	readonly draw: number;
	readonly black: number;
	readonly whiteLabel: string;
	readonly drawLabel: string;
	readonly blackLabel: string;
	readonly reference: ReferenceGame | null;
	readonly move: UciMove | null;
	readonly label: string;
}

@Component({
	selector: 'app-opening-tree',
	standalone: true,
	imports: [],
	templateUrl: './opening-tree.component.html',
	styleUrl: './opening-tree.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpeningTreeComponent {
	readonly explorer = inject(OpeningExplorerStore);

	readonly moveRequested = output<UciMove>();

	readonly status = computed(() => this.explorer.status());
	readonly error = computed(() => this.explorer.error());
	readonly isEmpty = computed(() => this.explorer.isEmpty());

	// Which side is about to move, and therefore which player in every reference game.
	private readonly moverIsWhite = computed(() => {
		const fen = this.explorer.totals().fen;
		return fen ? activeColor(fen) === Color.WHITE : true;
	});

	readonly totals = computed<RenderedMove | null>(() => {
		const tree = this.explorer.totals();
		if (tree.games === 0) {
			return null;
		}
		return this.render(
			{
				san: 'Σ',
				uci: '',
				games: tree.games,
				whiteWins: tree.whiteWins,
				draws: tree.draws,
				blackWins: tree.blackWins,
				whitePct: tree.whitePct,
				drawPct: tree.drawPct,
				blackPct: tree.blackPct,
				topGame: null,
			},
			tree.games,
		);
	});

	readonly rows = computed<readonly RenderedMove[]>(() => {
		const total = this.explorer.totals().games;
		const whiteMoves = this.moverIsWhite();
		return this.explorer.moves().map((move) => this.render(move, total, whiteMoves));
	});

	// Blurs first: the list re-renders for the new position and would destroy this button, moving
	// focus to the panel. detail === 0 (keyboard activation) skips it, keeping the ring visible.
	play(row: RenderedMove, event: MouseEvent): void {
		if (event.detail !== 0) {
			(event.currentTarget as HTMLElement).blur();
		}
		if (row.move) {
			this.moveRequested.emit(row.move);
		}
	}

	private render(move: OpeningTreeMove, totalGames: number, whiteIsMover = true): RenderedMove {
		const share = totalGames === 0 ? 0 : (move.games / totalGames) * 100;
		const reference = referenceGame(move.topGame, whiteIsMover);

		return {
			san: move.san,
			count: `${abbreviate(move.games)} / ${formatShare(share)}`,
			white: move.whitePct,
			draw: move.drawPct,
			black: move.blackPct,
			whiteLabel: segmentLabel(move.whitePct),
			drawLabel: drawSegmentLabel(move.drawPct),
			blackLabel: segmentLabel(move.blackPct),
			reference,
			move: move.uci ? parseUciMove(move.uci) : null,
			label:
				`${move.san}, ${move.games} games, ` +
				`white ${Math.round(move.whitePct)}%, draw ${Math.round(move.drawPct)}%, ` +
				`black ${Math.round(move.blackPct)}%` +
				(reference
					? `. ${reference.engine ? 'Only played by engines' : 'Highest rated'}: ${reference.white} versus ${reference.black} ${reference.tail}`
					: ''),
		};
	}
}

// Whole percent, except where that would read as zero.
function formatShare(percent: number): string {
	if (percent >= 0.5) {
		return `${Math.round(percent)}%`;
	}
	return percent >= 0.05 ? `${percent.toFixed(1)}%` : '<0.1%';
}

function abbreviate(games: number): string {
	if (games >= 1_000_000) {
		return `${(games / 1_000_000).toFixed(1)}M`;
	}
	if (games >= 10_000) {
		return `${Math.round(games / 1000)}K`;
	}
	if (games >= 1000) {
		return `${(games / 1000).toFixed(1)}K`;
	}
	return `${games}`;
}

function segmentLabel(percent: number): string {
	return percent >= 12 ? `${Math.round(percent)}%` : '';
}

function drawSegmentLabel(percent: number): string {
	return percent > 0 ? `${Math.round(percent)}%` : '';
}

function referenceGame(game: TopGame | null, whiteIsMover: boolean): ReferenceGame | null {
	if (!game) {
		return null;
	}
	const tail = [game.result, game.year].filter(Boolean).join(' · ');

	return {
		white: `${shortName(game.white)}${game.whiteElo ? ` ${game.whiteElo}` : ''}`,
		black: `${shortName(game.black)}${game.blackElo ? ` ${game.blackElo}` : ''}`,
		whiteIsMover,
		tail: tail ? `· ${tail}` : '',
		engine: game.engine,
	};
}

// Forenames are cut to an initial.
function shortName(name: string): string {
	const comma = name.indexOf(',');
	if (comma < 0) {
		return name;
	}
	const forename = name.slice(comma + 1).trim();
	return forename ? `${name.slice(0, comma)}, ${forename[0]}` : name.slice(0, comma);
}
