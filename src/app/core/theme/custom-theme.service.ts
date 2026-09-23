import { Injectable, signal } from '@angular/core';
import { CUSTOM_COLOR_SLOTS, CustomColors, derivedFrom } from './custom-theme';

@Injectable({ providedIn: 'root' })
export class CustomThemeService {
	private readonly current = signal<CustomColors>(null);
	readonly colors = this.current.asReadonly();

	// Idempotent and cheap: called on every drag of a colour input.
	apply(colors: CustomColors): void {
		this.current.set(colors);

		const style = document.body.style;
		if (!colors) {
			for (const slot of CUSTOM_COLOR_SLOTS) {
				style.removeProperty(slot.property);
			}
			style.removeProperty('--bg-border');
			style.removeProperty('--bg-hover');
			return;
		}

		CUSTOM_COLOR_SLOTS.forEach((slot, index) => style.setProperty(slot.property, colors[index]));

		const derived = derivedFrom(colors[0]);
		style.setProperty('--bg-border', derived.border);
		style.setProperty('--bg-hover', derived.hover);
	}

	baseColors(): string[] {
		const style = document.body.style;
		const applied = this.current();

		if (applied) {
			for (const slot of CUSTOM_COLOR_SLOTS) {
				style.removeProperty(slot.property);
			}
		}

		const computed = getComputedStyle(document.body);
		const base = CUSTOM_COLOR_SLOTS.map((slot) => toHex(computed.getPropertyValue(slot.property).trim()));

		if (applied) {
			CUSTOM_COLOR_SLOTS.forEach((slot, index) => style.setProperty(slot.property, applied[index]));
		}
		return base;
	}

	readBaseText(): string {
		return toHex(getComputedStyle(document.body).getPropertyValue('--text-main').trim());
	}
}

function toHex(value: string): string {
	if (/^#[0-9a-f]{6}$/i.test(value)) {
		return value.toLowerCase();
	}

	const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value);
	if (!match) {
		return '#808080';
	}
	return `#${match
		.slice(1, 4)
		.map((channel) => Number(channel).toString(16).padStart(2, '0'))
		.join('')}`;
}
