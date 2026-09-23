import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { NgStyle } from '@angular/common';
import { roleFromLetter } from '../../../../core/chess/piece-codec';
import { PieceComponent } from '../../../../shared/chess/piece.component';

export interface PromotionTarget {
	from: string;
	to: string;
	isWhite: boolean;
}

@Component({
	selector: 'app-promotion-overlay',
	standalone: true,
	imports: [NgStyle, PieceComponent],
	templateUrl: './promotion-overlay.component.html',
	styleUrl: './promotion-overlay.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PromotionOverlayComponent {
	@Input({ required: true }) target: PromotionTarget | null = null;
	@Input({ required: true }) overlayStyle: Record<string, string> = {};

	@Output() choose = new EventEmitter<string>();
	@Output() cancelled = new EventEmitter<void>();

	protected readonly promotionPieces: readonly string[] = ['q', 'n', 'r', 'b'];

	protected pieceClassName(type: string): string {
		return roleFromLetter(type);
	}

	protected pieceLabel(type: string): string {
		return `Promote to ${roleFromLetter(type)}`;
	}
}
