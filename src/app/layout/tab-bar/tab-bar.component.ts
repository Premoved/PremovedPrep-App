import {
	Component,
	ElementRef,
	HostListener,
	Injector,
	afterNextRender,
	effect,
	inject,
	signal,
	viewChild,
} from '@angular/core';

import { ReleaseFocusDirective } from '../../core/browser/release-focus.directive';
import { TabsStore } from '../../core/tabs/tabs.store';
import { BishopLogoComponent } from '../../shared/logo/bishop-logo.component';
import { RoyalLogoComponent } from '../../shared/logo/royal-logo.component';
import { KnightLogoComponent } from '../../shared/logo/knight-logo.component';
import { LogoComponent } from '../../shared/logo/logo.component';
import { PawnLogoComponent } from '../../shared/logo/pawn-logo.component';
import { RookLogoComponent } from '../../shared/logo/rook-logo.component';
import { PlanIconComponent } from '../../shared/logo/plan-icon.component';

@Component({
	selector: 'app-tab-bar',
	standalone: true,
	imports: [
		ReleaseFocusDirective,
		PawnLogoComponent,
		PlanIconComponent,
		KnightLogoComponent,
		BishopLogoComponent,
		RookLogoComponent,
		RoyalLogoComponent,
		LogoComponent,
	],
	templateUrl: './tab-bar.component.html',
	styleUrl: './tab-bar.component.scss',
})
export class TabBarComponent {
	readonly tabs = inject(TabsStore);
	private readonly injector = inject(Injector);

	private readonly strip = viewChild<ElementRef<HTMLElement>>('strip');

	readonly dragIndex = signal<number | null>(null);
	readonly dropIndex = signal<number | null>(null);

	constructor() {
		// Scrolls the new tab into view after the render that added it, not during the effect.
		effect(() => {
			const id = this.tabs.activeId();
			afterNextRender(() => this.reveal(id), { injector: this.injector });
		});
	}

	select(id: string): void {
		void this.tabs.select(id);
	}

	close(id: string): void {
		void this.tabs.close(id);
	}

	onAuxClick(event: MouseEvent, id: string): void {
		if (event.button !== 1) {
			return;
		}
		event.preventDefault();
		this.close(id);
	}

	onWheel(event: WheelEvent): void {
		const strip = this.strip()?.nativeElement;
		if (!strip || strip.scrollWidth <= strip.clientWidth) {
			return;
		}
		const by = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
		if (by === 0) {
			return;
		}
		event.preventDefault();
		strip.scrollLeft += by;
	}

	@HostListener('document:keydown', ['$event'])
	onKeydown(event: KeyboardEvent): void {
		if (!event.ctrlKey || event.altKey || event.metaKey) {
			return;
		}
		const key = event.key.toLowerCase();

		if (key === 't' && !event.shiftKey) {
			event.preventDefault();
			this.tabs.openTab();
		} else if (key === 'w' && !event.shiftKey) {
			// Closes the tab, not the window: with tabs in the title bar, there is no menu bar convention to match.
			event.preventDefault();
			this.close(this.tabs.activeId());
		} else if (event.key === 'Tab') {
			event.preventDefault();
			this.step(event.shiftKey ? -1 : 1);
		} else if (event.shiftKey && key === 'pageup') {
			event.preventDefault();
			this.tabs.moveActive(-1);
		} else if (event.shiftKey && key === 'pagedown') {
			event.preventDefault();
			this.tabs.moveActive(1);
		}
	}

	onTabDragStart(event: DragEvent, index: number): void {
		if (this.tabs.tabs().length < 2) {
			event.preventDefault();
			return;
		}
		this.dragIndex.set(index);
		const tab = this.tabs.tabs()[index];
		event.dataTransfer?.setData('text/plain', tab?.id ?? '');
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
	}

	onTabDragOver(event: DragEvent, index: number): void {
		if (this.dragIndex() === null) {
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const gap = event.clientX < box.left + box.width / 2 ? index : index + 1;
		this.dropIndex.set(gap);
	}

	onTabDragEnd(): void {
		this.dragIndex.set(null);
		this.dropIndex.set(null);
	}

	onTabDrop(event: DragEvent): void {
		event.preventDefault();
		const from = this.dragIndex();
		const to = this.dropIndex();
		this.onTabDragEnd();
		if (from !== null && to !== null) {
			this.tabs.reorderTabs(from, to);
		}
	}

	private step(by: number): void {
		const tabs = this.tabs.tabs();
		if (tabs.length < 2) {
			return;
		}
		const at = tabs.findIndex((tab) => tab.id === this.tabs.activeId());
		const next = tabs[(at + by + tabs.length) % tabs.length];
		this.select(next.id);
	}

	private reveal(id: string): void {
		const strip = this.strip()?.nativeElement;
		const tab = strip?.querySelector(`[data-tab="${CSS.escape(id)}"]`);
		tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}
}
