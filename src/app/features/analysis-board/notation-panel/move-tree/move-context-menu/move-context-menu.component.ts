import { ChangeDetectionStrategy, Component, OnDestroy, computed, input, output, signal } from '@angular/core';
import { ANNOTATION_OPTIONS } from '../../../../../core/chess/annotation-labels';
import { Annotation } from '../../../../../core/models/chess-enums';

export interface MenuPlacement {
	readonly x: number;
	readonly y: number;
	readonly lowSpace: boolean;
}

// Approximate sizes; pick the side of the anchor the menu opens on.
const COMPACT = { width: 200, height: 264 };
const GRID = { width: 300, height: 320 };
const GAP = 8;
const EDGE = 10;

@Component({
	selector: 'app-move-context-menu',
	standalone: true,
	imports: [],
	templateUrl: './move-context-menu.component.html',
	styleUrl: './move-context-menu.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MoveContextMenuComponent implements OnDestroy {
	readonly anchor = input.required<DOMRect>();
	readonly hasDrawings = input(false);
	readonly moveActions = input(true);
	readonly folded = input(false);
	readonly study = input(false);
	readonly foldDisabled = input(false);

	readonly promoteRequested = output<void>();
	readonly commentRequested = output<void>();
	readonly clearDrawingsRequested = output<void>();
	readonly foldRequested = output<void>();
	readonly deleteRequested = output<void>();
	readonly annotationPicked = output<Annotation>();

	readonly options = ANNOTATION_OPTIONS;

	readonly showAnnotations = signal(false);

	readonly forcedTooltip = signal<string | null>(null);

	readonly placement = computed<MenuPlacement>(() => {
		const rect = this.anchor();
		const size = this.showAnnotations() ? GRID : COMPACT;
		const lowSpace = rect.top + size.height > window.innerHeight;

		let x = rect.right + GAP;
		const y = lowSpace ? Math.max(EDGE, window.innerHeight - size.height - EDGE) : rect.top;

		// No room on the right: flip to the move's left edge.
		if (x + size.width > window.innerWidth) {
			x = rect.left - size.width - GAP;
		}
		x = Math.min(Math.max(x, EDGE), Math.max(EDGE, window.innerWidth - size.width - EDGE));

		return { x, y, lowSpace };
	});

	readonly narrowGrid = computed(() => {
		this.showAnnotations();
		return window.innerWidth < 400;
	});

	private tooltipTimer?: ReturnType<typeof setTimeout>;

	ngOnDestroy(): void {
		clearTimeout(this.tooltipTimer);
	}

	openAnnotations(): void {
		this.showAnnotations.set(true);
	}

	pick(option: Annotation): void {
		if (this.forcedTooltip() !== null) {
			this.forcedTooltip.set(null);
			return;
		}
		this.annotationPicked.emit(option);
	}

	startTooltipPress(label: string): void {
		clearTimeout(this.tooltipTimer);
		this.tooltipTimer = setTimeout(() => this.forcedTooltip.set(label), 500);
	}

	endTooltipPress(): void {
		clearTimeout(this.tooltipTimer);
		if (this.forcedTooltip() !== null) {
			this.tooltipTimer = setTimeout(() => this.forcedTooltip.set(null), 1000);
		}
	}
}
