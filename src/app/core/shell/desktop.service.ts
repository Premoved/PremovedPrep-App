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

	init(): void {
		if (!this.bridge) {
			return;
		}
		effect(() => {
			this.theme.theme();
			const styles = getComputedStyle(document.body);
			const color = styles.getPropertyValue('--bg-sidebar').trim();
			const symbolColor = styles.getPropertyValue('--text-main').trim();
			if (color.startsWith('#') && symbolColor.startsWith('#')) {
				void this.bridge?.setTitleBarColors(color, symbolColor);
			}
		});

		// Answering also flushes drafts, so the last few seconds of work are kept before the window closes.
		this.bridge.onAsk('unsaved', () => this.tabs.unkeptWork());
	}
}
