import {
	afterNextRender,
	ChangeDetectionStrategy,
	Component,
	DestroyRef,
	effect,
	ElementRef,
	inject,
	signal,
	untracked,
	viewChild,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ViewportService } from '../../core/layout/viewport.service';
import { BishopLogoComponent } from '../../shared/logo/bishop-logo.component';
import { KnightLogoComponent } from '../../shared/logo/knight-logo.component';
import { RookLogoComponent } from '../../shared/logo/rook-logo.component';
import { PawnLogoComponent } from '../../shared/logo/pawn-logo.component';

const RELEASE_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
const SCROLL_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function scrollParentOf(element: HTMLElement): HTMLElement | null {
	for (let node = element.parentElement; node !== null; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
			return node;
		}
	}
	return null;
}

interface GuideSection {
	readonly id: string;
	readonly label: string;
}

@Component({
	selector: 'app-home',
	standalone: true,
	imports: [RouterLink, PawnLogoComponent, RookLogoComponent, KnightLogoComponent, BishopLogoComponent],
	templateUrl: './home.component.html',
	styleUrl: './home.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeComponent {
	private readonly destroyRef = inject(DestroyRef);
	readonly viewport = inject(ViewportService);
	private readonly route = inject(ActivatedRoute);

	readonly sections: readonly GuideSection[] = [
		{ id: 'analysis-board', label: 'Analysis Board' },
		{ id: 'library', label: 'Library' },
		{ id: 'repertoire', label: 'Repertoire' },
		{ id: 'database-search', label: 'Database Search' },
		{ id: 'account', label: 'Account' },
		{ id: 'default-tools', label: 'Default tools' },
	];

	readonly active = signal<string>(this.sections[0].id);
	private readonly bodyEl = viewChild<ElementRef<HTMLElement>>('guideBody');
	private observer: IntersectionObserver | null = null;

	// Section a nav click targeted; overrides the scroll spy until the reader scrolls by hand.
	private pinned: string | null = null;
	private scrollTarget: EventTarget | null = null;
	private scroller: Element | null = null;
	private readonly onScroll = () => this.recompute();
	private readonly release = (event: Event) => {
		if (event instanceof KeyboardEvent && !SCROLL_KEYS.has(event.key)) {
			return;
		}
		if (this.pinned !== null) {
			this.pinned = null;
			this.recompute();
		}
	};

	constructor() {
		afterNextRender(() => {
			this.syncScrollSpy();
			this.openRequestedSection();
		});

		effect(() => {
			const mobile = this.viewport.isMobile();
			untracked(() => (mobile ? this.stopScrollSpy() : this.syncScrollSpy()));
		});

		this.destroyRef.onDestroy(() => this.stopScrollSpy());
	}

	private openRequestedSection(): void {
		const id = this.route.snapshot.fragment;
		if (id) {
			this.goTo(id);
		}
	}

	goTo(id: string): void {
		const target = this.sectionElements().find((element) => element.id === id);
		if (!target) {
			return;
		}

		this.pinned = id;
		this.active.set(id);
		target.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	private sectionElements(): readonly HTMLElement[] {
		const body = this.bodyEl()?.nativeElement;
		return body ? Array.from(body.querySelectorAll<HTMLElement>('.guide-section')) : [];
	}

	private headingElements(): readonly HTMLElement[] {
		const body = this.bodyEl()?.nativeElement;
		return body ? Array.from(body.querySelectorAll<HTMLElement>('.guide-section > .guide-heading')) : [];
	}

	private recompute(): void {
		if (this.pinned !== null) {
			this.active.set(this.pinned);
			return;
		}

		const headings = this.headingElements();
		if (headings.length === 0) {
			return;
		}

		// A short last section may never reach the top of the frame; at the bottom, force it active.
		const last = headings[headings.length - 1].parentElement?.id;
		if (last && this.atBottom()) {
			this.active.set(last);
			return;
		}

		const frame = this.frameHeight();
		let topmostVisible: string | null = null;
		let lastPassed: string | null = null;

		for (const heading of headings) {
			const id = heading.parentElement?.id;
			if (!id) {
				continue;
			}
			const rect = heading.getBoundingClientRect();
			if (rect.bottom <= 0) {
				lastPassed = id;
			} else if (rect.top < frame && topmostVisible === null) {
				topmostVisible = id;
			}
		}

		this.active.set(topmostVisible ?? lastPassed ?? this.sections[0].id);
	}

	private frameHeight(): number {
		return typeof window === 'undefined' ? 0 : window.innerHeight;
	}

	private syncScrollSpy(): void {
		if (this.observer || this.viewport.isMobile()) {
			return;
		}

		const headings = this.headingElements();
		if (headings.length === 0 || typeof IntersectionObserver === 'undefined') {
			return;
		}

		this.observer = new IntersectionObserver(() => this.recompute());
		for (const heading of headings) {
			this.observer.observe(heading);
		}

		const body = this.bodyEl()?.nativeElement;
		const pane = body ? scrollParentOf(body) : null;
		this.scroller = pane ?? document.scrollingElement;
		this.scrollTarget = pane ?? window;
		this.scrollTarget.addEventListener('scroll', this.onScroll, { passive: true });
		for (const type of RELEASE_EVENTS) {
			document.addEventListener(type, this.release, { capture: true, passive: true });
		}

		this.recompute();
	}

	private stopScrollSpy(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.scrollTarget?.removeEventListener('scroll', this.onScroll);
		this.scrollTarget = null;
		this.scroller = null;
		for (const type of RELEASE_EVENTS) {
			document.removeEventListener(type, this.release, { capture: true });
		}
	}

	private atBottom(): boolean {
		const element = this.scroller;
		return element !== null && element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
	}
}
