import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export interface GameMenuPlacement {
	readonly x: number;
	readonly y: number;
}

// Approximate size; picks the side of the anchor the menu opens on.
const SIZE = { width: 240, height: 96 };
const GAP = 8;
const EDGE = 10;

@Component({
	selector: 'app-game-context-menu',
	standalone: true,
	imports: [],
	templateUrl: './game-context-menu.component.html',
	styleUrl: './game-context-menu.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameContextMenuComponent {
	readonly anchor = input.required<DOMRect>();

	readonly showAddToAnalysis = input(true);

	readonly openRequested = output<void>();
	readonly addToAnalysisRequested = output<void>();

	readonly placement = computed<GameMenuPlacement>(() => {
		const rect = this.anchor();

		let x = rect.right + GAP;
		const y =
			rect.top + SIZE.height > window.innerHeight ? Math.max(EDGE, window.innerHeight - SIZE.height - EDGE) : rect.top;

		// No room on the right: flip to the row's left edge.
		if (x + SIZE.width > window.innerWidth) {
			x = rect.left - SIZE.width - GAP;
		}
		x = Math.min(Math.max(x, EDGE), Math.max(EDGE, window.innerWidth - SIZE.width - EDGE));

		return { x, y };
	});
}
