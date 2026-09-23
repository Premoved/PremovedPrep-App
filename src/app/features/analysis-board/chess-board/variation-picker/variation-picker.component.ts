import {
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	EventEmitter,
	Input,
	OnChanges,
	Output,
	SimpleChanges,
	inject,
} from '@angular/core';
import { moveNumberPrefix } from '../../../../core/chess/move-number';
import { PlyNode } from '../../../../core/models/move-node.model';

@Component({
	selector: 'app-variation-picker',
	standalone: true,
	templateUrl: './variation-picker.component.html',
	styleUrl: './variation-picker.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VariationPickerComponent implements OnChanges {
	private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

	@Input({ required: true }) variations: PlyNode[] = [];
	@Input({ required: true }) selectedIndex = 0;

	@Output() pick = new EventEmitter<PlyNode>();
	@Output() dismiss = new EventEmitter<void>();
	@Output() highlight = new EventEmitter<number>();

	protected readonly moveNumberPrefix = moveNumberPrefix;

	ngOnChanges(changes: SimpleChanges): void {
		if (changes['selectedIndex']) {
			queueMicrotask(() => this.scrollSelectedIntoView());
		}
	}

	private scrollSelectedIntoView(): void {
		const rows = this.host.nativeElement.querySelectorAll('.picker-item');
		rows.item(this.selectedIndex)?.scrollIntoView({ block: 'nearest' });
	}

	protected onOverlayClick(event: MouseEvent): void {
		if (event.target === event.currentTarget) {
			this.dismiss.emit();
		}
	}
}
