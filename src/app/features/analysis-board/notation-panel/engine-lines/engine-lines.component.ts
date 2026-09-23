import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { activeColor } from '../../../../core/chess/fen.util';
import { UciMove, formatScore, parseUciMove, pvToSan } from '../../../../core/engine/uci';
import { EngineStore } from '../../state/engine.store';

interface RenderedLine {
	readonly multipv: number;
	readonly score: string;
	readonly moves: string;
	readonly decisive: boolean;
	readonly firstMove: UciMove | null;
}

const PV_MOVES = 12;

@Component({
	selector: 'app-engine-lines',
	standalone: true,
	imports: [],
	templateUrl: './engine-lines.component.html',
	styleUrl: './engine-lines.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EngineLinesComponent {
	readonly engine = inject(EngineStore);

	readonly moveRequested = output<UciMove>();

	readonly lines = computed<readonly RenderedLine[]>(() => {
		// The position the engine searched, not wherever the tree happens to be.
		const fen = this.engine.positionFen();
		const turn = activeColor(fen);

		return this.engine.lines().map((line) => ({
			multipv: line.multipv,
			score: formatScore(line, turn),
			moves: pvToSan(fen, line.pv, PV_MOVES).join(' '),
			decisive: line.mate !== null || Math.abs(line.cp ?? 0) >= 300,
			firstMove: parseUciMove(line.pv[0] ?? ''),
		}));
	});

	play(line: RenderedLine): void {
		if (line.firstMove) this.moveRequested.emit(line.firstMove);
	}
}
