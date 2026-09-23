import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { ConfirmAnswer, ConfirmService } from '../../core/services/confirm.service';

@Component({
	selector: 'app-confirm-dialog',
	standalone: true,
	imports: [],
	templateUrl: './confirm-dialog.component.html',
	styleUrl: './confirm-dialog.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialogComponent {
	readonly confirm = inject(ConfirmService);

	private readonly anchorRect = signal<DOMRect | null>(null);

	readonly anchorStyle = computed(() => {
		const rect = this.anchorRect();
		if (!rect) {
			return null;
		}
		return { left: `${rect.left + rect.width / 2}px`, top: `${rect.top + rect.height / 2}px` };
	});

	constructor() {
		effect(() => {
			if (this.confirm.request()) {
				const board = document.querySelector('.board-pane');
				this.anchorRect.set(board?.getBoundingClientRect() ?? null);
			}
		});
	}

	answer(value: ConfirmAnswer): void {
		this.confirm.answer(value);
	}

	// Escape means "I didn't mean to open this"; where a third answer exists, use it rather than
	// pressing Discard on the user's behalf.
	@HostListener('document:keydown.escape')
	onEscape(): void {
		const request = this.confirm.request();
		if (request) {
			this.answer(request.dismissible ? 'dismiss' : 'cancel');
		}
	}
}
