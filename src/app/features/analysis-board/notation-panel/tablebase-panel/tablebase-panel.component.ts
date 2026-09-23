import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, output } from '@angular/core';
import { UciMove, parseUciMove } from '../../../../core/engine/uci';
import { TablebaseOutcome, categoryLabel, outcomeOf } from '../../../../core/models/tablebase.model';
import { TABLEBASE_MAX_PIECES } from '../../../../core/services/tablebase.service';
import { TablebaseStore } from '../../state/tablebase.store';

interface RenderedMove {
	readonly uci: string;
	readonly san: string;
	readonly outcome: TablebaseOutcome;
	readonly label: string;
	readonly distance: string;
	readonly move: UciMove | null;
}

@Component({
	selector: 'app-tablebase-panel',
	standalone: true,
	imports: [],
	templateUrl: './tablebase-panel.component.html',
	styleUrl: './tablebase-panel.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TablebasePanelComponent implements OnDestroy {
	readonly tablebase = inject(TablebaseStore);

	readonly moveRequested = output<UciMove>();

	readonly maxPieces = TABLEBASE_MAX_PIECES;

	readonly verdict = computed(() => {
		const result = this.tablebase.result();
		if (!result) {
			return null;
		}
		return {
			outcome: outcomeOf(result.category),
			label: categoryLabel(result.category),
			distance: distanceOf(result.dtm, result.dtz),
		};
	});

	readonly rows = computed<RenderedMove[]>(() =>
		this.tablebase.moves().map((move) => ({
			uci: move.uci,
			san: move.san,
			outcome: outcomeOf(move.category),
			label: categoryLabel(move.category),
			distance: distanceOf(move.dtm, move.dtz),
			move: parseUciMove(move.uci),
		})),
	);

	constructor() {
		// The store does nothing until something is looking at it.
		this.tablebase.setActive(true);
	}

	ngOnDestroy(): void {
		this.tablebase.setActive(false);
	}

	play(row: RenderedMove): void {
		if (row.move) {
			this.moveRequested.emit(row.move);
		}
	}
}

// 'DTM 17' when mate distance is known, otherwise 'DTZ n'.
function distanceOf(dtm: number | null, dtz: number | null): string {
	if (dtm !== null && dtm !== 0) {
		return `DTM ${Math.abs(dtm)}`;
	}
	if (dtz !== null && dtz !== 0) {
		return `DTZ ${Math.abs(dtz)}`;
	}
	return '';
}
