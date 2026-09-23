import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { MoveNode } from '../../../../core/models/move-node.model';
import { ReportPointKind } from '../../../../core/models/report.model';
import { ReportStore } from '../../state/report.store';

@Component({
	selector: 'app-report-bar',
	standalone: true,
	imports: [],
	template: `
		<div class="report-bar" role="group" aria-label="Walk the report's findings">
			<div class="group deviations">
				<span class="kind">Deviation</span>
				<button
					type="button"
					class="step"
					[disabled]="report.deviations().length === 0"
					(click)="step('DEVIATION', -1)"
					aria-label="Previous deviation"
					title="Previous deviation"
				>
					&lsaquo;
				</button>
				<span class="count" aria-live="polite">{{ report.deviationLabel() }}</span>
				<button
					type="button"
					class="step"
					[disabled]="report.deviations().length === 0"
					(click)="step('DEVIATION', 1)"
					aria-label="Next deviation"
					title="Next deviation"
				>
					&rsaquo;
				</button>
			</div>

			<span class="split" aria-hidden="true"></span>

			<div class="group overlaps">
				<span class="kind">Overlap</span>
				<button
					type="button"
					class="step"
					[disabled]="report.overlaps().length === 0"
					(click)="step('OVERLAP', -1)"
					aria-label="Previous overlap"
					title="Previous overlap"
				>
					&lsaquo;
				</button>
				<span class="count" aria-live="polite">{{ report.overlapLabel() }}</span>
				<button
					type="button"
					class="step"
					[disabled]="report.overlaps().length === 0"
					(click)="step('OVERLAP', 1)"
					aria-label="Next overlap"
					title="Next overlap"
				>
					&rsaquo;
				</button>
			</div>
		</div>
	`,
	styles: [
		`
			:host {
				display: block;
			}

			.report-bar {
				display: flex;
				flex-wrap: wrap;
				justify-content: center;
				align-items: center;
				gap: 0.4rem 0.9rem;
				padding: 0.45rem 0.75rem;
				border-bottom: 1px solid var(--bg-border);
				background: var(--bg-main);
			}

			.split {
				flex: none;
				width: 1px;
				height: 16px;
				background: var(--bg-border);
			}

			.group {
				display: flex;
				align-items: center;
				gap: 0.3rem;
				min-width: 0;
			}

			.kind {
				margin-right: 0.15rem;
				font-size: 0.62rem;
				font-weight: 700;
				letter-spacing: 0.05em;
				text-transform: uppercase;
				white-space: nowrap;
			}

			.deviations .kind {
				color: #c62828;
			}

			.overlaps .kind {
				color: #ff8c00;
			}

			.step {
				display: flex;
				align-items: center;
				justify-content: center;
				flex: none;
				width: 22px;
				height: 22px;
				padding: 0;
				border: 1px solid var(--bg-border);
				border-radius: 5px;
				background: var(--bg-main);
				font-family: inherit;
				font-size: 1rem;
				line-height: 1;
				color: var(--text-muted);
				cursor: default;
				transition:
					background 0.15s ease,
					border-color 0.15s ease,
					color 0.15s ease;
			}

			.step:hover:not(:disabled),
			.step:focus-visible:not(:disabled) {
				outline: none;
				background: var(--bg-hover);
				border-color: var(--accent-blue);
				color: var(--accent-blue);
			}

			/** Nothing of that kind was found: the pair stays, so the report still says none. */
			.step:disabled {
				opacity: 0.4;
			}

			.count {
				min-width: 3.2rem;
				text-align: center;
				font-size: 0.75rem;
				font-variant-numeric: tabular-nums;
				color: var(--text-muted);
				white-space: nowrap;
			}
		`,
	],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportBarComponent {
	readonly report = inject(ReportStore);

	readonly pick = output<MoveNode>();

	step(kind: ReportPointKind, delta: number): void {
		const node = this.report.step(kind, delta);
		if (node) {
			this.pick.emit(node);
		}
	}
}
