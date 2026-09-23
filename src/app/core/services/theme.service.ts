import { Injectable, signal } from '@angular/core';

export type ThemeName = 'light' | 'dark';

const STORAGE_KEY = 'premovedprep.theme';

// Light is the default everywhere: it is what :root carries in styles.css, so first paint is
// already light before this has run. Dark is a choice, never inferred from the OS.
@Injectable({ providedIn: 'root' })
export class ThemeService {
	readonly theme = signal<ThemeName>('light');

	init(): void {
		const stored = localStorage.getItem(STORAGE_KEY) as ThemeName | null;
		this.apply(stored === 'dark' ? 'dark' : 'light');
	}

	toggle(): void {
		this.apply(this.theme() === 'dark' ? 'light' : 'dark');
	}

	set(theme: ThemeName): void {
		this.apply(theme);
	}

	// Called when a session ends: without this the next account on this machine inherits the theme
	// of the one that just left, having chosen nothing.
	reset(): void {
		this.apply('light');
	}

	private apply(theme: ThemeName): void {
		this.theme.set(theme);
		document.body.classList.remove('light', 'dark');
		document.body.classList.add(theme);
		localStorage.setItem(STORAGE_KEY, theme);
	}
}
