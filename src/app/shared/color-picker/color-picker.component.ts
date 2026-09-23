import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

const MENU_WIDTH = 232;
const MENU_HEIGHT = 214;

const HEX = /^#[0-9a-f]{6}$/i;

@Component({
	selector: 'app-color-picker',
	standalone: true,
	imports: [],
	templateUrl: './color-picker.component.html',
	styleUrl: './color-picker.component.scss',
	host: {
		'(document:click)': 'close()',
	},
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColorPickerComponent {
	readonly value = input.required<string>();

	readonly label = input('Colour');

	readonly presets = input<readonly string[]>([]);

	readonly valueChange = output<string>();

	readonly open = signal(false);

	readonly at = signal<{ x: number; y: number } | null>(null);

	readonly typing = signal<string | null>(null);

	readonly hexText = computed(() => this.typing() ?? this.value());

	toggle(event: MouseEvent): void {
		event.stopPropagation();

		if (this.open()) {
			this.close();
			return;
		}

		this.at.set(place(event.currentTarget as HTMLElement));
		this.typing.set(null);
		this.open.set(true);
	}

	close(): void {
		if (!this.open()) return;
		this.open.set(false);
		this.typing.set(null);
	}

	// Stops the host's document:click listener from closing the menu when a click lands inside it.
	keepOpen(event: MouseEvent): void {
		event.stopPropagation();
	}

	choose(colour: string): void {
		this.typing.set(null);
		this.emit(colour);
	}

	onNative(event: Event): void {
		this.emit((event.target as HTMLInputElement).value);
	}

	onHex(event: Event): void {
		const raw = (event.target as HTMLInputElement).value.trim();
		const candidate = raw.startsWith('#') ? raw : `#${raw}`;

		this.typing.set(raw);
		if (HEX.test(candidate)) {
			this.emit(candidate.toLowerCase());
		}
	}

	onHexBlur(): void {
		this.typing.set(null);
	}

	isSelected(colour: string): boolean {
		return colour.toLowerCase() === this.value().toLowerCase();
	}

	private emit(colour: string): void {
		if (colour.toLowerCase() === this.value().toLowerCase()) return;
		this.valueChange.emit(colour);
	}
}

function place(trigger: HTMLElement): { x: number; y: number } {
	const box = trigger.getBoundingClientRect();
	const margin = 8;

	const below = box.bottom + 6;
	const y = below + MENU_HEIGHT > window.innerHeight - margin ? Math.max(margin, box.top - MENU_HEIGHT - 6) : below;
	const x = Math.max(margin, Math.min(box.left, window.innerWidth - MENU_WIDTH - margin));

	return { x, y };
}
