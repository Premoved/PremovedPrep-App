export interface CustomColorSlot {
	readonly property: string;
	readonly name: string;
}

export const CUSTOM_COLOR_SLOTS: readonly CustomColorSlot[] = [
	{ property: '--bg-main', name: 'Page' },
	{ property: '--bg-sidebar', name: 'Sidebar' },
	{ property: '--bg-elevated', name: 'Panels' },
];

export const CUSTOM_COLOR_PRESETS: readonly (readonly string[])[] = [
	['#ffffff', '#f5f4f0', '#e8e5dd', '#3a3a3a', '#2e2e2e', '#1e1c1a'],
	['#ffffff', '#f5f4f0', '#e9e6df', '#353535', '#2e2e2e', '#262421'],
	['#ffffff', '#faf9f6', '#ebe8e1', '#302f2c', '#262421', '#1c1b19'],
];

/** Three hex colours in CUSTOM_COLOR_SLOTS order, or null to follow light/dark. */
export type CustomColors = readonly string[] | null;

const HEX = /^#[0-9a-f]{6}$/i;

export function normaliseCustomColors(raw: unknown): CustomColors {
	if (!Array.isArray(raw) || raw.length !== CUSTOM_COLOR_SLOTS.length) {
		return null;
	}
	const colours = raw.filter((value): value is string => typeof value === 'string' && HEX.test(value));
	return colours.length === CUSTOM_COLOR_SLOTS.length ? colours : null;
}

export function customColorsEqual(a: CustomColors, b: CustomColors): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	return a.length === b.length && a.every((colour, index) => colour === b[index]);
}

/** Derives the border and hover colours from the page colour. */
export function derivedFrom(page: string): { border: string; hover: string } {
	const dark = luminance(page) < 0.5;
	return dark
		? { border: mix(page, '#ffffff', 0.14), hover: 'rgba(255, 255, 255, 0.05)' }
		: { border: mix(page, '#000000', 0.12), hover: 'rgba(0, 0, 0, 0.04)' };
}

export function legibility(background: string, text: string): 'fine' | 'poor' | 'unreadable' {
	const ratio = contrast(background, text);
	if (ratio >= 4.5) return 'fine';
	return ratio >= 3 ? 'poor' : 'unreadable';
}

function contrast(a: string, b: string): number {
	const first = luminance(a);
	const second = luminance(b);
	const lighter = Math.max(first, second);
	const darker = Math.min(first, second);
	return (lighter + 0.05) / (darker + 0.05);
}

export function luminance(hex: string): number {
	const [r, g, b] = channels(hex).map((value) => {
		const scaled = value / 255;
		return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mix(hex: string, towards: string, amount: number): string {
	const from = channels(hex);
	const to = channels(towards);
	const mixed = from.map((value, index) => Math.round(value + (to[index] - value) * amount));
	return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function channels(hex: string): [number, number, number] {
	if (!HEX.test(hex)) {
		return [128, 128, 128];
	}
	return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
