import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class EngineLoadStore {
	private readonly _running = signal(0);

	readonly running = this._running.asReadonly();

	/** Counts this board in, and hands back the release. Releasing twice is a no-op. */
	claim(): () => void {
		this._running.update((count) => count + 1);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this._running.update((count) => Math.max(0, count - 1));
		};
	}
}
