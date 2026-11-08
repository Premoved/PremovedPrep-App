export interface BoardTheme {
	readonly id: string;
	readonly name: string;
	/** Square colours. For a textured board, the texture's average tones: shown until it loads. */
	readonly light: string;
	readonly dark: string;
	/** A whole-board image under public/, fetched by tools/fetch-lichess-boards.mjs. */
	readonly image?: string;
}

export const DEFAULT_BOARD_THEME = 'brown';

// The classic Lichess boards: three flat colourings and two of its wood textures.
export const BOARD_THEMES: readonly BoardTheme[] = [
	{ id: 'brown', name: 'Brown', light: '#f0d9b5', dark: '#b58863' },
	{ id: 'blue', name: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
	{ id: 'green', name: 'Green', light: '#ffffdd', dark: '#86a666' },
	{ id: 'wood', name: 'Wood', light: '#d8b583', dark: '#a6743f', image: 'board/wood.jpg' },
	{ id: 'maple', name: 'Maple', light: '#ebd2a3', dark: '#c79a62', image: 'board/maple.jpg' },
];

// Boards that were offered before, mapped to the nearest one still offered.
const RETIRED_BOARD_THEMES: Readonly<Record<string, string>> = {
	default: 'brown',
	walnut: 'wood',
	forest: 'green',
	marine: 'blue',
	slate: 'blue',
	midnight: 'blue',
};

export function normaliseBoardThemeId(id: string): string {
	const current = RETIRED_BOARD_THEMES[id] ?? id;
	return BOARD_THEMES.some((theme) => theme.id === current) ? current : DEFAULT_BOARD_THEME;
}

export function findBoardTheme(id: string | null | undefined): BoardTheme {
	return BOARD_THEMES.find((theme) => theme.id === id) ?? BOARD_THEMES[0];
}
