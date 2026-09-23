import { Injectable } from '@angular/core';

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;
const TEXT_ENTRY = 'input, textarea, select, [contenteditable]';
// Window after the synthetic contextmenu in which a native one counts as a duplicate.
const NATIVE_WINDOW_MS = 1500;

@Injectable({ providedIn: 'root' })
export class LongPressService {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private startX = 0;
	private startY = 0;
	private target: HTMLElement | null = null;
	private firedAt = 0;

	private dispatching = false;
	private swallowClick = false;

	constructor() {
		document.addEventListener('pointerdown', this.onPointerDown, { capture: true, passive: true });
		document.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: true });
		document.addEventListener('pointerup', this.cancel, { capture: true, passive: true });
		document.addEventListener('pointercancel', this.cancel, { capture: true, passive: true });
		document.addEventListener('scroll', this.cancel, { capture: true, passive: true });
		document.addEventListener('contextmenu', this.onContextMenu, { capture: true });
		document.addEventListener('click', this.onClick, { capture: true });
	}

	private readonly onPointerDown = (event: PointerEvent): void => {
		this.cancel();
		this.swallowClick = false;
		if (event.pointerType === 'mouse') return;

		const target = event.target as HTMLElement | null;
		if (!target || target.closest(TEXT_ENTRY)) return;

		this.target = target;
		this.startX = event.clientX;
		this.startY = event.clientY;
		this.timer = setTimeout(() => this.fire(), LONG_PRESS_MS);
	};

	private readonly onPointerMove = (event: PointerEvent): void => {
		if (this.timer === null) return;
		if (Math.abs(event.clientX - this.startX) > MOVE_TOLERANCE_PX) this.cancel();
		else if (Math.abs(event.clientY - this.startY) > MOVE_TOLERANCE_PX) this.cancel();
	};

	private readonly cancel = (): void => {
		if (this.timer === null) return;
		clearTimeout(this.timer);
		this.timer = null;
		this.target = null;
	};

	private fire(): void {
		this.timer = null;
		const target = (document.elementFromPoint(this.startX, this.startY) as HTMLElement | null) ?? this.target;
		this.target = null;
		if (!target) return;

		this.swallowClick = true;
		this.dispatching = true;
		target.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				view: window,
				clientX: this.startX,
				clientY: this.startY,
				button: 2,
				buttons: 2,
			}),
		);
		this.dispatching = false;
		this.firedAt = Date.now();

		navigator.vibrate?.(10);
	}

	private readonly onContextMenu = (event: MouseEvent): void => {
		if (this.dispatching) return;
		if (!event.isTrusted) return;

		// Evaluated per press, not latched: one native contextmenu must not disable synthesis elsewhere.
		this.cancel();

		if (Date.now() - this.firedAt < NATIVE_WINDOW_MS) {
			event.preventDefault();
			event.stopPropagation();
		}
	};

	private readonly onClick = (event: MouseEvent): void => {
		if (!this.swallowClick) return;
		this.swallowClick = false;
		event.preventDefault();
		event.stopPropagation();
	};
}
