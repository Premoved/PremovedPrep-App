import { Injectable, computed, signal } from '@angular/core';
import { DEFAULT_THEME, THEMES, ThemeName, ThemeScheme, findTheme, isThemeName } from '../theme/themes';

export type { ThemeName } from '../theme/themes';

const STORAGE_KEY = 'premovedprep.theme';

// The last theme used on each side, so the sidebar's sun/moon button returns to it.
const LAST_LIGHT_KEY = 'premovedprep.theme.lastLight';
const LAST_DARK_KEY = 'premovedprep.theme.lastDark';

const THEME_CLASSES = THEMES.map((theme) => `theme-${theme.id}`);

// Light is the default everywhere: it is what :root carries in styles.css, so first paint is
// already light before this has run. Every other theme is a choice, never inferred from the OS.
@Injectable({ providedIn: 'root' })
export class ThemeService {
	readonly theme = signal<ThemeName>(DEFAULT_THEME);
	readonly scheme = computed<ThemeScheme>(() => findTheme(this.theme()).scheme);
	readonly themes = THEMES;

	init(): void {
		this.apply(this.read(STORAGE_KEY) ?? DEFAULT_THEME);
	}

	/** Swaps to the other side of light/dark, landing on whichever theme was last used there. */
	toggle(): void {
		const goingDark = this.scheme() === 'light';
		const remembered = this.read(goingDark ? LAST_DARK_KEY : LAST_LIGHT_KEY);
		const fallback: ThemeName = goingDark ? 'dark' : 'light';
		const target =
			remembered && findTheme(remembered).scheme === (goingDark ? 'dark' : 'light') ? remembered : fallback;
		this.apply(target);
	}

	set(theme: ThemeName): void {
		this.apply(theme);
	}

	// Called when a session ends: without this the next account on this machine inherits the theme
	// of the one that just left, having chosen nothing.
	reset(): void {
		this.apply(DEFAULT_THEME);
	}

	private apply(theme: ThemeName): void {
		const option = findTheme(theme);
		this.theme.set(option.id);

		const classes = document.body.classList;
		classes.remove('light', 'dark', ...THEME_CLASSES);
		classes.add(option.scheme, `theme-${option.id}`);

		document.querySelector('meta[name="theme-color"]')?.setAttribute('content', option.preview.page);

		this.write(STORAGE_KEY, option.id);
		this.write(option.scheme === 'dark' ? LAST_DARK_KEY : LAST_LIGHT_KEY, option.id);
	}

	private read(key: string): ThemeName | null {
		try {
			const stored = localStorage.getItem(key);
			return isThemeName(stored) ? stored : null;
		} catch {
			return null;
		}
	}

	private write(key: string, value: ThemeName): void {
		try {
			localStorage.setItem(key, value);
		} catch {
			// Private mode, or the quota is full: the theme still applies for this session.
		}
	}
}
