export interface BoardTheme {
	readonly id: string;
	readonly name: string;
	readonly light: string;
	readonly dark: string;
}

export const DEFAULT_BOARD_THEME = 'brown';

export const BOARD_THEMES: readonly BoardTheme[] = [
	{ id: 'brown', name: 'Brown', light: '#f0d9b5', dark: '#b58863' },
	{ id: 'blue', name: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
	{ id: 'green', name: 'Green', light: '#ffffdd', dark: '#86a666' },
	{ id: 'forest', name: 'Forest', light: '#eeeed2', dark: '#769656' },
	{ id: 'ice', name: 'Ice', light: '#ececec', dark: '#c1c18e' },
	{ id: 'purple', name: 'Purple', light: '#e3dcef', dark: '#8877a8' },
	{ id: 'walnut', name: 'Walnut', light: '#e8d0aa', dark: '#9c6b3f' },
	{ id: 'marine', name: 'Marine', light: '#cfd8e8', dark: '#6b7f9e' },
	{ id: 'slate', name: 'Slate', light: '#d7dce2', dark: '#6a7681' },
	{ id: 'grey', name: 'Grey', light: '#dcdcdc', dark: '#9a9a9a' },
	{ id: 'rose', name: 'Rose', light: '#f4dedc', dark: '#b98287' },
	{ id: 'midnight', name: 'Midnight', light: '#8b95a4', dark: '#414b58' },
];

export function findBoardTheme(id: string | null | undefined): BoardTheme {
	return BOARD_THEMES.find((theme) => theme.id === id) ?? BOARD_THEMES[0];
}
