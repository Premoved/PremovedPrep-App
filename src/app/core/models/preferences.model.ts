import { DrawBrush, DrawBrushes } from '@lichess-org/chessground/draw';
import { DEFAULT_BOARD_THEME } from '../board/board-themes';
import { DEFAULT_PIECE_SET } from '../board/piece-sets';
import { CustomColors, customColorsEqual, normaliseCustomColors } from '../theme/custom-theme';

export interface AppPreferences {
	readonly pieceSet: string;
	readonly boardTheme: string;
	readonly coordinates: boolean;
	readonly moveDests: MoveDestStyle;
	readonly arrowColors: readonly string[];
	readonly sound: boolean;
	readonly customColors: CustomColors;
}

export type MoveDestStyle = 'ring' | 'dot';

/** The four drawing brushes, in the order chessground's modifier keys select them. */
export interface ArrowSlot {
	readonly brush: 'green' | 'red' | 'blue' | 'yellow';
	readonly keys: string;
	readonly action: string;
}

export const ARROW_SLOTS: readonly ArrowSlot[] = [
	{ brush: 'green', keys: 'Right-click', action: 'drag' },
	{ brush: 'red', keys: 'Shift + right-click', action: 'drag' },
	{ brush: 'blue', keys: 'Alt + right-click', action: 'drag' },
	{ brush: 'yellow', keys: 'Shift + Alt + right-click', action: 'drag' },
];

export const DEFAULT_ARROW_COLORS: readonly string[] = ['#4a6a8a', '#627b3d', '#ff8c00', '#c62828'];

export const ARROW_PALETTE: readonly string[] = [
	'#4a6a8a',
	'#3d78ad',
	'#1b7f79',
	'#627b3d',
	'#3f8f3f',
	'#a8a020',
	'#ff8c00',
	'#d2691e',
	'#c62828',
	'#b0306b',
	'#8e44ad',
	'#5b4bbd',
	'#5a5a5a',
	'#111111',
];

export const DEFAULT_PREFERENCES: AppPreferences = {
	pieceSet: DEFAULT_PIECE_SET,
	boardTheme: DEFAULT_BOARD_THEME,
	coordinates: false,
	moveDests: 'ring',
	arrowColors: DEFAULT_ARROW_COLORS,
	sound: true,
	customColors: null,
};

const HEX = /^#[0-9a-f]{6}$/i;

// Old theme id -> its current replacement, for values already stored under the old name.
const RETIRED_BOARD_THEMES: Readonly<Record<string, string>> = { default: 'brown' };

export function normalisePreferences(raw: unknown): AppPreferences {
	if (typeof raw !== 'object' || raw === null) {
		return DEFAULT_PREFERENCES;
	}

	const source = raw as Partial<Record<keyof AppPreferences, unknown>>;
	const colors = Array.isArray(source.arrowColors) ? source.arrowColors : [];

	return {
		pieceSet: typeof source.pieceSet === 'string' ? source.pieceSet : DEFAULT_PREFERENCES.pieceSet,
		boardTheme:
			typeof source.boardTheme === 'string'
				? (RETIRED_BOARD_THEMES[source.boardTheme] ?? source.boardTheme)
				: DEFAULT_PREFERENCES.boardTheme,
		coordinates: typeof source.coordinates === 'boolean' ? source.coordinates : DEFAULT_PREFERENCES.coordinates,
		moveDests:
			source.moveDests === 'dot' || source.moveDests === 'ring' ? source.moveDests : DEFAULT_PREFERENCES.moveDests,
		arrowColors: DEFAULT_ARROW_COLORS.map((fallback, index) => {
			const candidate: unknown = colors[index];
			return typeof candidate === 'string' && HEX.test(candidate) ? candidate : fallback;
		}),
		sound: typeof source.sound === 'boolean' ? source.sound : DEFAULT_PREFERENCES.sound,
		customColors: normaliseCustomColors(source.customColors),
	};
}

const ARROW_LINE_WIDTH = 10;

export function arrowBrushes(colors: readonly string[]): DrawBrushes {
	const brush = (index: number): DrawBrush => ({
		key: ARROW_SLOTS[index].brush,
		color: colors[index] ?? DEFAULT_ARROW_COLORS[index],
		opacity: 1,
		lineWidth: ARROW_LINE_WIDTH,
	});

	return { green: brush(0), red: brush(1), blue: brush(2), yellow: brush(3) };
}

export function preferencesEqual(a: AppPreferences, b: AppPreferences): boolean {
	return (
		a.pieceSet === b.pieceSet &&
		a.boardTheme === b.boardTheme &&
		a.coordinates === b.coordinates &&
		a.moveDests === b.moveDests &&
		a.sound === b.sound &&
		customColorsEqual(a.customColors, b.customColors) &&
		a.arrowColors.length === b.arrowColors.length &&
		a.arrowColors.every((colour, index) => colour === b.arrowColors[index])
	);
}
