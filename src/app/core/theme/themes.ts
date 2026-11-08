export type ThemeName = 'light' | 'sepia' | 'dim' | 'dark' | 'burgundy';

/** Which side of the light/dark split a theme is on. Component rules key on it as a body class. */
export type ThemeScheme = 'light' | 'dark';

export interface ThemeOption {
	readonly id: ThemeName;
	readonly name: string;
	readonly scheme: ThemeScheme;
	/** The few colours the picker draws for this theme, copied from its block in styles.css. */
	readonly preview: {
		readonly page: string;
		readonly panel: string;
		readonly ink: string;
		readonly accent: string;
	};
}

export const DEFAULT_THEME: ThemeName = 'light';

export const THEMES: readonly ThemeOption[] = [
	{
		id: 'light',
		name: 'Light',
		scheme: 'light',
		preview: { page: '#f5f4f0', panel: '#ffffff', ink: '#2b2926', accent: '#35597a' },
	},
	{
		id: 'sepia',
		name: 'Sepia',
		scheme: 'light',
		preview: { page: '#ede5d7', panel: '#fbf8f2', ink: '#2d2620', accent: '#35597a' },
	},
	{
		id: 'dim',
		name: 'Dim',
		scheme: 'dark',
		preview: { page: '#2a2723', panel: '#37332e', ink: '#ece6de', accent: '#95c0ea' },
	},
	{
		id: 'dark',
		name: 'Dark',
		scheme: 'dark',
		preview: { page: '#1c1a18', panel: '#2a2724', ink: '#e8e3dc', accent: '#8ab8e6' },
	},
	{
		id: 'burgundy',
		name: 'Burgundy',
		scheme: 'dark',
		preview: { page: '#1d1617', panel: '#2c2223', ink: '#eddfdb', accent: '#8fbbe6' },
	},
];

export function isThemeName(value: unknown): value is ThemeName {
	return THEMES.some((theme) => theme.id === value);
}

export function findTheme(id: ThemeName): ThemeOption {
	return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}
