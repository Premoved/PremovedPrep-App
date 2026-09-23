import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
	selector: 'app-import-dialog',
	standalone: true,
	imports: [FormsModule],
	templateUrl: './import-dialog.component.html',
	styleUrl: './import-dialog.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImportDialogComponent {
	@Input() set initialFen(fen: string) {
		this.fenValue = fen;
	}

	@Output() loadFen = new EventEmitter<string>();
	@Output() loadPgn = new EventEmitter<string>();
	@Output() closed = new EventEmitter<void>();

	protected fenValue = '';
	protected pgnValue = '';
}
