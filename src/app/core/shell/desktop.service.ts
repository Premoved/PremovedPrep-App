import { Injectable, effect, inject, signal } from '@angular/core';

import { DesktopApi } from './desktop-bridge';
import { ThemeService } from '../services/theme.service';
import { TabsStore } from '../tabs/tabs.store';

@Injectable({ providedIn: 'root' })
export class DesktopService {
	private readonly bridge: DesktopApi | null = window.premovedDesktop ?? null;
	private readonly theme = inject(ThemeService);
	private readonly tabs = inject(TabsStore);

	readonly isDesktop = signal(this.bridge !== null);

	// Windows draws the window buttons; no backdrop can reach them, so they are darkened to match instead.
	private readonly dimmed = signal(false);

	setDimmed(dimmed: boolean): void {
		this.dimmed.set(dimmed);
	}

	init(): void {
		if (!this.bridge) {
			return;
		}
		effect(() => {
			this.theme.theme();
			const dimmed = this.dimmed();
			const styles = getComputedStyle(document.body);
			const color = styles.getPropertyValue('--bg-sidebar').trim();
			const symbolColor = styles.getPropertyValue('--text-main').trim();
			if (color.startsWith('#') && symbolColor.startsWith('#')) {
				void this.bridge?.setTitleBarColors(
					dimmed ? underBackdrop(color) : color,
					dimmed ? underBackdrop(symbolColor) : symbolColor,
				);
			}
		});

		// Answering also flushes drafts, so the last few seconds of work are kept before the window closes.
		this.bridge.onAsk('unsaved', () => this.tabs.unkeptWork());
	}
}

// Matches the Subscription Plan page's lightbox backdrop, so the Windows-drawn corner darkens the same amount.
export const BACKDROP_RGB: readonly [number, number, number] = [15, 17, 20];
export const BACKDROP_ALPHA = 0.6;

function underBackdrop(hex: string): string {
	let digits = hex.slice(1);
	if (digits.length === 3 || digits.length === 4) {
		digits = [...digits.slice(0, 3)].map((digit) => digit + digit).join('');
	}
	const channels = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
	if (channels.some((value) => Number.isNaN(value))) {
		return hex;
	}
	return (
		'#' +
		channels
			.map((value, at) => Math.round(value * (1 - BACKDROP_ALPHA) + BACKDROP_RGB[at] * BACKDROP_ALPHA))
			.map((value) => value.toString(16).padStart(2, '0'))
			.join('')
	);
}
