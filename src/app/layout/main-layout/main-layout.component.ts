import { Component, DestroyRef, HostListener, computed, effect, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { NavigationEnd, NavigationStart, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { ViewportService } from '../../core/layout/viewport.service';
import { LogoComponent } from '../../shared/logo/logo.component';
import { KnightLogoComponent } from '../../shared/logo/knight-logo.component';
import { RookLogoComponent } from '../../shared/logo/rook-logo.component';
import { BishopLogoComponent } from '../../shared/logo/bishop-logo.component';
import { PawnLogoComponent } from '../../shared/logo/pawn-logo.component';
import { RoyalLogoComponent } from '../../shared/logo/royal-logo.component';
import { ConfirmDialogComponent } from '../../shared/confirm-dialog/confirm-dialog.component';
import { TabBarComponent } from '../tab-bar/tab-bar.component';
import { DesktopService } from '../../core/shell/desktop.service';
import { TabsStore } from '../../core/tabs/tabs.store';
import { ReleaseFocusDirective } from '../../core/browser/release-focus.directive';
import { environment } from '../../../environments/environment';
import { fitOnScreen } from '../../core/browser/menu-placement';
import { PlanAccessService } from '../../core/services/plan-access.service';
import { LockedPage, PlanRequiredNoticeComponent } from '../../shared/plan-required/plan-required-notice.component';
import { PlanIconComponent } from '../../shared/logo/plan-icon.component';

const PLAN_PAGES: Readonly<Record<string, LockedPage>> = {
	analysis: {
		mark: 'pawn',
		title: 'Analysis Board',
		description:
			'An analysis board with an engine, an opening tree over the game archive, and repertoire tools. Paste a PGN or a FEN and start from any position.',
	},
	search: {
		mark: 'knight',
		title: 'Database Search',
		description:
			'Search the game archive by opponent or by position: every game a FIDE player has in the database, their openings by colour, and the lines they repeat.',
	},
	library: { mark: 'bishop', title: 'Library', description: 'A place for keeping ideas and studies organized.' },
	repertoire: { mark: 'rook', title: 'Repertoire', description: 'A place for keeping opening ideas and preparation.' },
	resources: {
		mark: 'royal',
		title: 'Local Resources',
		description:
			'Choose a root folder for saving files on this computer, index your own local databases, and add any local engine.',
	},
};

function lockedPageOf(url: string): LockedPage | null {
	const segment = url.split(/[?#]/)[0].split('/').filter(Boolean)[0] ?? '';
	return Object.hasOwn(PLAN_PAGES, segment) ? PLAN_PAGES[segment] : null;
}

interface RailTooltip {
	readonly text: string;
	readonly x: number;
	readonly y: number;
}

interface NavContextMenu {
	readonly path: string;
	readonly x: number;
	readonly y: number;
}

const NAV_MENU_FOOTPRINT = { width: 176, height: 44 };

@Component({
	selector: 'app-main-layout',
	standalone: true,
	imports: [
		NgTemplateOutlet,
		RouterLink,
		RouterLinkActive,
		RouterOutlet,
		LogoComponent,
		KnightLogoComponent,
		RookLogoComponent,
		BishopLogoComponent,
		PawnLogoComponent,
		RoyalLogoComponent,
		ConfirmDialogComponent,
		TabBarComponent,
		ReleaseFocusDirective,
		PlanRequiredNoticeComponent,
		PlanIconComponent,
	],
	templateUrl: './main-layout.component.html',
	styleUrl: './main-layout.component.css',
})
export class MainLayoutComponent {
	readonly auth = inject(AuthService);
	readonly desktop = inject(DesktopService);
	readonly tabs = inject(TabsStore);
	readonly theme = inject(ThemeService);
	readonly viewport = inject(ViewportService);
	private readonly router = inject(Router);
	private readonly plan = inject(PlanAccessService);
	readonly collapsed = signal(false);

	private readonly url = signal(this.router.url);

	readonly lockedPage = computed(() => lockedPageOf(this.url()));

	readonly pageLock = computed(() => (this.lockedPage() !== null ? this.plan.lock() : null));

	readonly sourceCodeUrl = environment.sourceCodeUrl;

	readonly contactEmail = environment.contactEmail;

	readonly railTooltip = signal<RailTooltip | null>(null);

	showRailTooltip(event: Event): void {
		if (!this.collapsed()) return;
		this.showTooltipFor(event);
	}

	showAccountTooltip(event: Event): void {
		this.showTooltipFor(event);
	}

	private showTooltipFor(event: Event): void {
		const el = event.currentTarget as HTMLElement;
		const text = el.dataset['tooltip']?.trim() || el.querySelector('.nav-label')?.textContent?.trim();
		if (!text) return;

		const rect = el.getBoundingClientRect();
		this.railTooltip.set({ text, x: rect.right + 10, y: rect.top + rect.height / 2 });
	}

	hideRailTooltip(): void {
		this.railTooltip.set(null);
	}
	readonly toggleOffset = signal<number | null>(null);
	readonly dragging = signal(false);
	private dragStartY = 0;
	private dragMoved = false;

	toggleSidebar(): void {
		this.collapsed.update((v) => !v);
	}

	startDrag(event: PointerEvent): void {
		event.preventDefault();
		this.dragging.set(true);
		this.dragMoved = false;
		this.dragStartY = event.clientY;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onDrag(event: PointerEvent, sidebarEl: HTMLElement): void {
		if (!this.dragging()) {
			return;
		}
		if (Math.abs(event.clientY - this.dragStartY) > 3) {
			this.dragMoved = true;
		}
		const rect = sidebarEl.getBoundingClientRect();
		const min = 16;
		const max = rect.height - 32;
		const y = Math.min(Math.max(event.clientY - rect.top, min), max);
		this.toggleOffset.set(y);
	}

	stopDrag(): void {
		if (!this.dragging()) {
			return;
		}
		this.dragging.set(false);
		if (!this.dragMoved) {
			this.toggleSidebar();
		}
	}

	logout(): void {
		this.auth.logout();
	}

	private readonly drawerOpen = signal(false);

	readonly drawerVisible = computed(() => this.viewport.isMobile() && this.drawerOpen());

	constructor() {
		const navigation = this.router.events.subscribe((event) => {
			// On Start, not only End: the unsaved-changes guard prompts during navigation, and a
			// cancelled navigation never fires End, which would leave the drawer open over the prompt.
			if (event instanceof NavigationStart || event instanceof NavigationEnd) {
				this.drawerOpen.set(false);
			}
			if (event instanceof NavigationEnd) {
				this.url.set(event.urlAfterRedirects);
			}
		});
		inject(DestroyRef).onDestroy(() => navigation.unsubscribe());

		effect(() => {
			document.body.style.overflow = this.drawerVisible() ? 'hidden' : '';
		});
	}

	toggleDrawer(): void {
		this.drawerOpen.update((open) => !open);
	}

	closeDrawer(): void {
		this.drawerOpen.set(false);
	}

	@HostListener('document:keydown.escape')
	onEscape(): void {
		this.closeDrawer();
	}

	readonly navContextMenu = signal<NavContextMenu | null>(null);

	onNavContextMenu(event: MouseEvent, path: string): void {
		// stopPropagation keeps the document click handler from closing this menu immediately.
		event.preventDefault();
		event.stopPropagation();
		const at = fitOnScreen(event.clientX, event.clientY, NAV_MENU_FOOTPRINT);
		this.navContextMenu.set({ path, x: at.x, y: at.y });
	}

	openNavInNewTab(): void {
		const menu = this.navContextMenu();
		this.closeNavContextMenu();
		if (!menu) {
			return;
		}
		this.tabs.openElsewhere(menu.path);
	}

	@HostListener('document:click')
	@HostListener('document:contextmenu')
	@HostListener('window:blur')
	closeNavContextMenu(): void {
		this.navContextMenu.set(null);
	}
}
