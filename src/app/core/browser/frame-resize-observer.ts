// rAF-coalesced to one call per frame: avoids "ResizeObserver loop completed" errors.
export class FrameResizeObserver {
	private readonly observer: ResizeObserver;
	private frame = 0;

	constructor(callback: () => void) {
		this.observer = new ResizeObserver(() => {
			if (this.frame !== 0) return;
			this.frame = requestAnimationFrame(() => {
				this.frame = 0;
				callback();
			});
		});
	}

	observe(target: Element): void {
		this.observer.observe(target);
	}

	disconnect(): void {
		if (this.frame !== 0) {
			cancelAnimationFrame(this.frame);
			this.frame = 0;
		}
		this.observer.disconnect();
	}
}
