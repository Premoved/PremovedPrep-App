import { Injectable } from '@angular/core';

const HOLD_MS = 2500;
const GAP_PX = 8;
const EDGE_PX = 8;

/** On touch screens, a long press on a button that shows no readable text labels it with its title. */
@Injectable({ providedIn: 'root' })
export class LongPressTooltipService {
	private node: HTMLDivElement | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;

	init(): void {
		document.addEventListener('contextmenu', (event) => this.onLongPress(event));
		document.addEventListener('pointerdown', () => this.hide(), { capture: true, passive: true });
		window.addEventListener('scroll', () => this.hide(), { capture: true, passive: true });
	}

	private onLongPress(event: MouseEvent): void {
		// Already labelled by its own handler: TooltipDirective or the board's utility tooltip.
		if (event.defaultPrevented || !matchMedia('(hover: none)').matches) {
			return;
		}
		const button = (event.target as Element | null)?.closest<HTMLElement>('button, [role="button"]');
		if (!button || button.closest('[data-tooltip]') || !showsNoText(button)) {
			return;
		}
		const text = (button.getAttribute('title') ?? button.getAttribute('aria-label') ?? '').trim();
		if (!text) {
			return;
		}
		event.preventDefault();
		this.show(button, text);
	}

	private show(anchor: HTMLElement, text: string): void {
		this.hide();
		const node = document.createElement('div');
		node.className = 'touch-tooltip';
		node.textContent = text;
		document.body.appendChild(node);

		const target = anchor.getBoundingClientRect();
		const own = node.getBoundingClientRect();
		const left = clamp(target.left + target.width / 2 - own.width / 2, EDGE_PX, innerWidth - own.width - EDGE_PX);
		const above = target.top - GAP_PX - own.height;
		node.style.left = `${left}px`;
		node.style.top = `${above >= EDGE_PX ? above : target.bottom + GAP_PX}px`;

		this.node = node;
		this.timer = setTimeout(() => this.hide(), HOLD_MS);
	}

	private hide(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.node?.remove();
		this.node = null;
	}
}

// Icons and glyphs only (an svg, «, ×), or a label the layout hides or cuts short.
function showsNoText(button: HTMLElement): boolean {
	if (!/[\p{L}\p{N}]/u.test(button.innerText)) {
		return true;
	}
	return [button, ...button.querySelectorAll<HTMLElement>('*')].some(
		(element) => getComputedStyle(element).textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1,
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, Math.max(min, max)));
}
