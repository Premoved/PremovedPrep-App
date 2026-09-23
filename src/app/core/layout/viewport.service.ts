import { Injectable, signal } from '@angular/core';

/** The single breakpoint at which the shell changes shape. Mirrored in the stylesheets. */
export const MOBILE_MAX_WIDTH_PX = 899.98;

@Injectable({ providedIn: 'root' })
export class ViewportService {
	private readonly query = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH_PX}px)`);

	readonly isMobile = signal(this.query.matches);

	constructor() {
		this.query.addEventListener('change', (event) => this.isMobile.set(event.matches));
	}
}
