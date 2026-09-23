import { DestroyRef, Injectable, Injector, computed, inject, signal } from '@angular/core';
import {
	ActivatedRoute,
	ActivatedRouteSnapshot,
	DetachedRouteHandle,
	NavigationCancel,
	NavigationEnd,
	NavigationError,
	Router,
} from '@angular/router';

export type TabSection =
	'analysis' | 'search' | 'library' | 'repertoire' | 'resources' | 'plan' | 'settings' | 'home' | 'other';

export interface Tab {
	readonly id: string;
	readonly url: string;
	readonly label: string;
	readonly section: TabSection;
}

const STORAGE_KEY = 'premovedprep.tabs';
const NEW_TAB_URL = '/home';

const SECTION_LABELS: Readonly<Record<string, string>> = {
	home: 'Home',
	analysis: 'Analysis Board',
	search: 'Database Search',
	library: 'Library',
	repertoire: 'Repertoire',
	resources: 'Local Resources',
	plan: 'Subscription Plan',
	settings: 'Settings',
	terms: 'Terms of service',
	privacy: 'Privacy policy',
};

interface StoredTabs {
	readonly tabs: readonly Tab[];
	readonly activeId: string;
}

/** Open tabs. Only the active one is mounted; TabRouteReuseStrategy keeps the rest detached. */
@Injectable({ providedIn: 'root' })
export class TabsStore {
	// Resolved on demand: the reuse strategy is built with this store, and the Router with the
	// strategy, so injecting Router in a field here would close that circle before either exists.
	private readonly injector = inject(Injector);
	private readonly destroyRef = inject(DestroyRef);

	private get router(): Router {
		return this.injector.get(Router);
	}

	private get route(): ActivatedRoute {
		return this.injector.get(ActivatedRoute);
	}

	private readonly open = signal<readonly Tab[]>([]);
	private readonly active = signal<string>('');

	readonly tabs = this.open.asReadonly();
	readonly activeId = this.active.asReadonly();
	readonly closable = computed(() => this.open().length > 1);

	private readonly handles = new Map<string, DetachedRouteHandle>();

	private readonly scrollMarks = new Map<string, Map<Element, { top: number; left: number }>>();

	detachingTo: string | null = null;
	attachingTo: string | null = null;

	get inTransition(): boolean {
		return this.detachingTo !== null || this.attachingTo !== null;
	}

	get keepingCurrentPage(): boolean {
		return this.detachingTo !== null;
	}

	// Read from a page's constructor, which runs before NavigationEnd updates `active`.
	get owningTab(): string {
		return this.attachingTo ?? this.active();
	}

	private readonly pages = new Map<string, object>();

	claimTab(id: string, page: object): void {
		if (id.length > 0) {
			this.pages.set(id, page);
		}
	}

	releaseTab(id: string, page: object): void {
		if (this.pages.get(id) === page) {
			this.pages.delete(id);
		}
	}

	// Not "how many are unsaved": a kept draft returns exactly as left. Counts only where keeping failed.
	unkeptWork(): number {
		let count = 0;
		for (const page of this.pages.values()) {
			const ask = (page as { hasUnkeptWork?: () => boolean }).hasUnkeptWork;
			if (typeof ask === 'function' && ask.call(page)) {
				count += 1;
			}
		}
		return count;
	}

	private counter = 0;

	private desktop = false;

	init(restore: boolean): void {
		this.desktop = restore;

		document.addEventListener('scroll', this.rememberScroll, { capture: true, passive: true });
		this.destroyRef.onDestroy(() => document.removeEventListener('scroll', this.rememberScroll, { capture: true }));
		if (restore) {
			const stored = this.read();
			this.open.set(stored.tabs);
			this.active.set(stored.activeId);
		}

		// Minted before the first navigation ends, so a board opened before `adopt` runs still has an owner.
		if (this.active().length === 0) {
			this.active.set(this.nextId());
		}

		let first = true;
		const events = this.router.events.subscribe((event) => {
			if (event instanceof NavigationEnd) {
				// Set here, not when navigateByUrl resolves: this event fires first.
				const entered = this.attachingTo;
				this.detachingTo = null;
				this.attachingTo = null;
				if (entered !== null) {
					this.active.set(entered);
				}
				if (first) {
					first = false;
					this.adopt(event.urlAfterRedirects, restore);
					return;
				}
				this.follow(event.urlAfterRedirects);
			} else if (event instanceof NavigationCancel || event instanceof NavigationError) {
				this.detachingTo = null;
				this.attachingTo = null;
			}
		});
		this.destroyRef.onDestroy(() => events.unsubscribe());
	}

	openElsewhere(url: string): void {
		if (this.desktop) {
			this.openTab(url);
			return;
		}
		window.open(url, '_blank', 'noopener');
	}

	openTab(url: string = NEW_TAB_URL): void {
		const tab: Tab = { id: this.nextId(), url, label: this.labelFromUrl(url), section: sectionOf(url) };
		this.open.update((tabs) => [...tabs, tab]);
		this.persist();
		void this.select(tab.id)
			.then((entered) => {
				if (!entered) {
					this.dropTab(tab.id);
				}
			})
			.catch(() => this.dropTab(tab.id));
	}

	private dropTab(id: string): void {
		this.open.update((tabs) => tabs.filter((open) => open.id !== id));
		this.persist();
	}

	// `to` is a gap between tabs (0..length), so lifting the tab out shifts everything after it up by one.
	reorderTabs(from: number, to: number): void {
		const tabs = this.open();
		const moved = tabs[from];
		if (!moved) {
			return;
		}
		const target = to > from ? to - 1 : to;
		if (target === from || target < 0 || target >= tabs.length) {
			return;
		}
		const next = [...tabs];
		next.splice(from, 1);
		next.splice(target, 0, moved);
		this.open.set(next);
		this.persist();
	}

	moveActive(delta: 1 | -1): void {
		const tabs = this.open();
		const at = tabs.findIndex((tab) => tab.id === this.active());
		const to = at + delta;
		if (at < 0 || to < 0 || to >= tabs.length) {
			return;
		}
		const next = [...tabs];
		const [moved] = next.splice(at, 1);
		next.splice(to, 0, moved);
		this.open.set(next);
		this.persist();
	}

	select(id: string): Promise<boolean> {
		if (id === this.active()) {
			return Promise.resolve(false);
		}
		const target = this.open().find((tab) => tab.id === id);
		if (!target) {
			return Promise.resolve(false);
		}

		const leaving = this.active();
		this.detachingTo = leaving.length > 0 ? leaving : null;
		this.attachingTo = id;

		// reload: two tabs can hold the same URL, and the router's default ignores navigating to it again.
		return this.router.navigateByUrl(target.url, { onSameUrlNavigation: 'reload' });
	}

	async close(id: string): Promise<void> {
		const tabs = this.open();
		if (tabs.length <= 1) {
			return;
		}
		const index = tabs.findIndex((tab) => tab.id === id);
		if (index < 0) {
			return;
		}
		const next = tabs[index + 1] ?? tabs[index - 1];

		if (id === this.active()) {
			this.attachingTo = next.id;
			const left = await this.router.navigateByUrl(next.url, { onSameUrlNavigation: 'reload' });
			if (!left) {
				this.attachingTo = null;
				return;
			}
		} else if (!(await this.confirmDetachedClose(id))) {
			return;
		}

		this.discard(id);
		this.scrollMarks.delete(id);
		this.open.update((open) => open.filter((tab) => tab.id !== id));
		this.persist();
	}

	putHandle(id: string, handle: DetachedRouteHandle): void {
		this.discard(id);
		this.handles.set(id, handle);
		this.tell(handle, 'onTabHidden');
	}

	hasHandle(id: string): boolean {
		return this.handles.has(id);
	}

	// The router asks for a handle twice per navigation; removing it on the first ask lost the page
	// to a freshly built one on the second.
	peekHandle(id: string): DetachedRouteHandle | null {
		return this.handles.get(id) ?? null;
	}

	forgetHandle(id: string): void {
		const handle = this.handles.get(id);
		this.handles.delete(id);
		this.tell(handle, 'onTabShown');
		this.restoreScroll(id);
	}

	// A detached page's nodes leave the document while off screen and lose scrollTop; recorded live
	// because by the time of a switch the number is already gone.
	private readonly rememberScroll = (event: Event): void => {
		const target = event.target === document ? document.scrollingElement : event.target;
		if (!(target instanceof Element)) {
			return;
		}
		const id = this.active();
		if (id.length === 0) {
			return;
		}
		let marks = this.scrollMarks.get(id);
		if (!marks) {
			marks = new Map();
			this.scrollMarks.set(id, marks);
		}
		marks.set(target, { top: target.scrollTop, left: target.scrollLeft });
	};

	private restoreScroll(id: string): void {
		const marks = this.scrollMarks.get(id);
		if (!marks || marks.size === 0) {
			return;
		}
		const snapshot = [...marks].map(([element, at]) => ({ element, ...at }));

		const apply = (): void => {
			for (const at of snapshot) {
				if (!at.element.isConnected) {
					continue;
				}
				if (at.top > 0) {
					at.element.scrollTop = at.top;
				}
				if (at.left > 0) {
					at.element.scrollLeft = at.left;
				}
			}
		};

		// Twice, a frame apart: the second pass catches panels that size themselves once back on screen.
		requestAnimationFrame(() => {
			apply();
			requestAnimationFrame(apply);
		});
	}

	private tell(handle: DetachedRouteHandle | undefined, what: 'onTabHidden' | 'onTabShown'): void {
		const page = componentOf(handle)?.instance as Record<string, unknown> | undefined;
		const method = page?.[what];
		if (typeof method === 'function') {
			(method as () => void).call(page);
		}
	}

	// A detached page is outside the component tree, so nothing else destroys it: without this its
	// engine and subscriptions would keep running for the life of the application.
	private discard(id: string): void {
		const handle = this.handles.get(id);
		this.handles.delete(id);
		componentOf(handle)?.destroy();
	}

	private async confirmDetachedClose(id: string): Promise<boolean> {
		const page = componentOf(this.handles.get(id))?.instance as { confirmDiscardOrSave?: () => Promise<boolean> };
		if (page && typeof page.confirmDiscardOrSave === 'function') {
			return page.confirmDiscardOrSave();
		}
		return true;
	}

	private adopt(url: string, restore: boolean): void {
		const tabs = this.open();
		const current = tabs.find((tab) => tab.id === this.active());

		if (!current) {
			const tab: Tab = {
				id: this.active() || this.nextId(),
				url,
				label: this.labelFromRoute(url),
				section: sectionOf(url),
			};
			this.open.set([tab]);
			this.active.set(tab.id);
			this.persist();
			return;
		}

		if (restore && current.url !== url) {
			void this.router.navigateByUrl(current.url);
			return;
		}
		this.follow(url);
	}

	private follow(url: string): void {
		const id = this.active();
		this.open.update((tabs) =>
			tabs.map((tab) => {
				if (tab.id !== id || tab.url === url) {
					return tab;
				}
				return { ...tab, url, label: this.labelFromRoute(url), section: sectionOf(url) };
			}),
		);
		this.persist();
	}

	describe(label: string | null): void {
		if (this.inTransition) {
			return;
		}
		const id = this.active();
		if (id.length === 0) {
			return;
		}
		const named = label?.trim();
		this.open.update((tabs) =>
			tabs.map((tab) =>
				tab.id === id ? { ...tab, label: named && named.length > 0 ? named : this.labelFromRoute(tab.url) } : tab,
			),
		);
		this.persist();
	}

	private labelFromRoute(url: string): string {
		let snapshot: ActivatedRouteSnapshot = this.route.snapshot;
		while (snapshot.firstChild) {
			snapshot = snapshot.firstChild;
		}
		const title = snapshot.data['title'];
		return typeof title === 'string' && title.length > 0 ? title : this.labelFromUrl(url);
	}

	private labelFromUrl(url: string): string {
		return SECTION_LABELS[firstSegment(url)] ?? 'PremovedPrep';
	}

	private nextId(): string {
		this.counter += 1;
		return `t${Date.now().toString(36)}${this.counter.toString(36)}`;
	}

	private persist(): void {
		try {
			const value: StoredTabs = { tabs: this.open(), activeId: this.active() };
			localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
		} catch {
			// Storage unavailable: tabs are not restored next start.
		}
	}

	private read(): StoredTabs {
		const empty: StoredTabs = { tabs: [], activeId: '' };
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) {
				return empty;
			}
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null) {
				return empty;
			}
			const candidate = parsed as { tabs?: unknown; activeId?: unknown };
			if (!Array.isArray(candidate.tabs) || typeof candidate.activeId !== 'string') {
				return empty;
			}
			const tabs = candidate.tabs
				.filter(isTab)
				.map((tab) => ({ id: tab.id, url: tab.url, label: tab.label, section: sectionOf(tab.url) }));
			if (tabs.length === 0 || !tabs.some((tab) => tab.id === candidate.activeId)) {
				return empty;
			}
			return { tabs, activeId: candidate.activeId };
		} catch {
			return empty;
		}
	}
}

const SECTIONS: ReadonlySet<string> = new Set([
	'analysis',
	'search',
	'library',
	'repertoire',
	'resources',
	'plan',
	'settings',
	'home',
]);

function firstSegment(url: string): string {
	return url.split(/[?#]/)[0].split('/').filter(Boolean)[0] ?? 'home';
}

function sectionOf(url: string): TabSection {
	const segment = firstSegment(url);
	return SECTIONS.has(segment) ? (segment as TabSection) : 'other';
}

function isTab(value: unknown): value is Tab {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as { id?: unknown; url?: unknown; label?: unknown };
	return typeof candidate.id === 'string' && typeof candidate.url === 'string' && typeof candidate.label === 'string';
}

// Reads a field that is not part of DetachedRouteHandle's public (deliberately opaque) shape;
// without it a closed tab's page could not be reached to destroy.
function componentOf(handle: DetachedRouteHandle | undefined): { instance: unknown; destroy(): void } | null {
	if (!handle || typeof handle !== 'object') {
		return null;
	}
	const candidate = (handle as { componentRef?: unknown }).componentRef;
	if (!candidate || typeof candidate !== 'object') {
		return null;
	}
	const reference = candidate as { instance?: unknown; destroy?: unknown };
	if (typeof reference.destroy !== 'function') {
		return null;
	}
	return reference as { instance: unknown; destroy(): void };
}
