export function scrollableAncestor(el: HTMLElement): HTMLElement | null {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const overflowY = getComputedStyle(node).overflowY;
		if (/^(auto|scroll|overlay)$/.test(overflowY) && node.scrollHeight > node.clientHeight + 1) {
			return node;
		}
	}
	return null;
}

/** Scrolls only `container`; unlike scrollIntoView, other ancestors' scroll positions are untouched. */
export function scrollIntoContainer(
	container: HTMLElement,
	target: HTMLElement,
	{
		block = 'center',
		behavior = 'auto',
		margin = 0,
	}: { block?: 'center' | 'nearest'; behavior?: ScrollBehavior; margin?: number } = {},
): void {
	const containerBox = container.getBoundingClientRect();
	const targetBox = target.getBoundingClientRect();

	// clientHeight excludes the horizontal scrollbar; the bounding box does not.
	const contentTop = containerBox.top + container.clientTop;
	const contentBottom = contentTop + container.clientHeight;

	const above = targetBox.top - contentTop - margin;
	const below = targetBox.bottom - contentBottom + margin;

	let delta: number;
	if (block === 'center') {
		delta = targetBox.top - contentTop - (container.clientHeight - targetBox.height) / 2;
	} else {
		if (above >= 0 && below <= 0) return;
		delta = above < 0 ? above : below;
	}

	const max = container.scrollHeight - container.clientHeight;
	const top = Math.max(0, Math.min(container.scrollTop + delta, max));
	if (Math.abs(top - container.scrollTop) < 1) return;

	container.scrollTo({ top, behavior });
}
