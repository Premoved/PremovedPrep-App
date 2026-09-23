import { ActivatedRouteSnapshot, DetachedRouteHandle, RouteReuseStrategy } from '@angular/router';

import { TabsStore } from './tabs.store';

/** Detaches the page a tab switch is leaving and reattaches a tab's stored page; ordinary navigation is untouched. */
export class TabRouteReuseStrategy implements RouteReuseStrategy {
	constructor(private readonly tabs: TabsStore) {
		// Parameter properties only.
	}

	shouldDetach(route: ActivatedRouteSnapshot): boolean {
		return this.tabs.detachingTo !== null && isPage(route);
	}

	store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
		if (!isPage(route)) {
			return;
		}

		// null = no longer detached; sent for the entered tab after its handle is reattached.
		if (handle === null) {
			const entered = this.tabs.attachingTo;
			if (entered !== null) {
				this.tabs.forgetHandle(entered);
			}
			return;
		}

		const leaving = this.tabs.detachingTo;
		if (leaving === null) {
			return;
		}
		this.tabs.putHandle(leaving, handle);
	}

	shouldAttach(route: ActivatedRouteSnapshot): boolean {
		const id = this.tabs.attachingTo;
		return id !== null && isPage(route) && this.tabs.hasHandle(id);
	}

	// Asked more than once per navigation; the handle is dropped by store(route, null), not here.
	retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
		const id = this.tabs.attachingTo;
		if (id === null || !isPage(route)) {
			return null;
		}
		return this.tabs.peekHandle(id);
	}

	// Two tabs on the same route are two pages, not one; without this a switch would reuse the mounted component.
	shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
		if (this.tabs.inTransition && isPage(curr) && future.routeConfig === curr.routeConfig) {
			return false;
		}
		return future.routeConfig === curr.routeConfig;
	}
}

function isPage(route: ActivatedRouteSnapshot): boolean {
	return route.routeConfig !== null && route.routeConfig.children === undefined;
}
