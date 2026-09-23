import { ChangeDetectionStrategy, Component } from '@angular/core';

// Claims the <piece> tag chessground renders so Angular treats it as a known element, not an error.
@Component({
	selector: 'piece',
	standalone: true,
	template: '',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PieceComponent {}
