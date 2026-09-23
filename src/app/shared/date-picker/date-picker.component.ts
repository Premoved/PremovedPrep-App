import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

interface CalendarDay {
	readonly value: string;
	readonly day: number;
	readonly inMonth: boolean;
	readonly isToday: boolean;
	readonly isSelected: boolean;
	readonly disabled: boolean;
}

export type DateFormat = 'pgn' | 'iso';

const MENU_WIDTH = 250;
const MENU_HEIGHT = 318;

@Component({
	selector: 'app-date-picker',
	standalone: true,
	imports: [],
	templateUrl: './date-picker.component.html',
	styleUrl: './date-picker.component.scss',
	host: {
		'(document:click)': 'close()',
	},
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DatePickerComponent {
	readonly value = input('');
	readonly format = input<DateFormat>('iso');

	/** Latest date that may be picked, or null for no ceiling. */
	readonly max = input<'today' | null>(null);

	readonly placeholder = input('?');

	readonly valueChange = output<string>();

	readonly weekdayLabels: readonly string[] = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

	readonly open = signal(false);
	readonly at = signal<{ x: number; y: number } | null>(null);

	private readonly month = signal<{ year: number; month: number }>(monthOfToday());

	readonly monthLabel = computed(() => {
		const { year, month } = this.month();
		return new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
	});

	readonly display = computed(() => this.value() || this.placeholder());
	readonly isEmpty = computed(() => !this.value());

	// 42 cells: a fixed six-week grid, so the layout doesn't reflow between months.
	readonly calendarDays = computed<readonly CalendarDay[]>(() => {
		const { year, month } = this.month();
		const selected = this.value();
		const today = new Date();
		const todayValue = this.formatDate(today);
		const ceiling = this.max() === 'today' ? endOfDay(today) : null;

		const firstOfMonth = new Date(year, month, 1);
		const leadingDays = (firstOfMonth.getDay() + 6) % 7;

		const days: CalendarDay[] = [];
		for (let i = 0; i < 42; i++) {
			const cellDate = new Date(year, month, 1 - leadingDays + i);
			const value = this.formatDate(cellDate);
			days.push({
				value,
				day: cellDate.getDate(),
				inMonth: cellDate.getMonth() === month,
				isToday: value === todayValue,
				isSelected: value === selected,
				disabled: ceiling !== null && cellDate.getTime() > ceiling,
			});
		}
		return days;
	});

	readonly canGoForward = computed(() => {
		if (this.max() !== 'today') {
			return true;
		}
		const { year, month } = this.month();
		const now = new Date();
		return year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth());
	});

	toggle(event: Event): void {
		event.stopPropagation();
		if (this.open()) {
			this.open.set(false);
			return;
		}
		this.month.set(this.parsed() ?? monthOfToday());
		this.at.set(place((event.currentTarget as HTMLElement).getBoundingClientRect()));
		this.open.set(true);
	}

	// Stops the host's document:click listener from closing the panel when a click lands inside it.
	keepOpen(event: Event): void {
		event.stopPropagation();
	}

	close(): void {
		this.open.set(false);
	}

	prevMonth(): void {
		this.month.update(({ year, month }) => (month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }));
	}

	nextMonth(): void {
		if (!this.canGoForward()) {
			return;
		}
		this.month.update(({ year, month }) => (month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }));
	}

	pick(cell: CalendarDay): void {
		if (cell.disabled) {
			return;
		}
		this.valueChange.emit(cell.value);
		this.open.set(false);
	}

	pickToday(): void {
		this.valueChange.emit(this.formatDate(new Date()));
		this.open.set(false);
	}

	clear(): void {
		this.valueChange.emit('');
		this.open.set(false);
	}

	private parsed(): { year: number; month: number } | null {
		const match = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/.exec(this.value().trim());
		return match ? { year: Number(match[1]), month: Number(match[2]) - 1 } : null;
	}

	private formatDate(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const separator = this.format() === 'pgn' ? '.' : '-';
		return `${year}${separator}${month}${separator}${day}`;
	}
}

function monthOfToday(): { year: number; month: number } {
	const now = new Date();
	return { year: now.getFullYear(), month: now.getMonth() };
}

function endOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
}

function place(trigger: DOMRect): { x: number; y: number } {
	const margin = 8;
	const below = trigger.bottom + 4;
	const fitsBelow = below + MENU_HEIGHT <= window.innerHeight - margin;
	const y = fitsBelow ? below : Math.max(margin, trigger.top - 4 - MENU_HEIGHT);
	const x = Math.max(margin, Math.min(trigger.left, window.innerWidth - MENU_WIDTH - margin));
	return { x, y };
}
