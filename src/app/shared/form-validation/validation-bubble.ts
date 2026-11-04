import { ValidatedField } from './validation-message';

// One bubble on screen at a time, drawn by the application rather than the browser so it looks and
// reads the same everywhere. Shaped after Chrome's: a box under the field, a caret pointing at it,
// an orange mark. Styles are global (.validation-bubble in styles.css) because it lives on <body>.

const GAP_PX = 8;
const EDGE_PX = 8;
const CARET_INSET_PX = 22;

interface Shown {
	readonly field: ValidatedField;
	readonly node: HTMLDivElement;
	readonly dispose: () => void;
}

let shown: Shown | null = null;

export function showValidationBubble(field: ValidatedField, message: string): void {
	hideValidationBubble();

	const node = document.createElement('div');
	node.className = 'validation-bubble';
	node.setAttribute('role', 'alert');

	const mark = document.createElement('span');
	mark.className = 'validation-bubble-mark';
	mark.setAttribute('aria-hidden', 'true');
	mark.textContent = '!';

	const text = document.createElement('span');
	text.className = 'validation-bubble-text';
	text.textContent = message;

	node.append(mark, text);
	document.body.appendChild(node);

	field.setAttribute('aria-invalid', 'true');

	let frame = 0;
	const place = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => position(field, node));
	};
	const onPointerDown = (event: PointerEvent) => {
		if (!node.contains(event.target as Node)) hideValidationBubble();
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key === 'Escape') hideValidationBubble();
	};
	const onInput = () => hideValidationBubble();
	// Long enough to read twice; as Chrome's, it does not stay up indefinitely.
	const timer = setTimeout(hideValidationBubble, Math.min(10_000, Math.max(5_000, message.length * 90)));

	window.addEventListener('scroll', place, { capture: true, passive: true });
	window.addEventListener('resize', place);
	window.visualViewport?.addEventListener('resize', place);
	window.visualViewport?.addEventListener('scroll', place);
	document.addEventListener('pointerdown', onPointerDown, true);
	document.addEventListener('keydown', onKey, true);
	field.addEventListener('input', onInput);

	shown = {
		field,
		node,
		dispose: () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
			window.removeEventListener('scroll', place, { capture: true });
			window.removeEventListener('resize', place);
			window.visualViewport?.removeEventListener('resize', place);
			window.visualViewport?.removeEventListener('scroll', place);
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('keydown', onKey, true);
			field.removeEventListener('input', onInput);
		},
	};

	position(field, node);
}

export function hideValidationBubble(): void {
	if (!shown) return;
	const { field, node, dispose } = shown;
	shown = null;
	dispose();
	node.remove();
	field.removeAttribute('aria-invalid');
}

// Hides the bubble only if it belongs to a field inside `container`: a form being destroyed must not
// close a bubble another form has just opened.
export function hideValidationBubbleWithin(container: Element): void {
	if (shown && container.contains(shown.field)) hideValidationBubble();
}

function position(field: ValidatedField, node: HTMLDivElement): void {
	const rect = field.getBoundingClientRect();
	const viewport = window.visualViewport;
	const top = viewport?.offsetTop ?? 0;
	const left = viewport?.offsetLeft ?? 0;
	const width = viewport?.width ?? window.innerWidth;
	const height = viewport?.height ?? window.innerHeight;

	// A field scrolled out of view has nothing to point at.
	if (rect.bottom < top || rect.top > top + height || rect.width === 0) {
		hideValidationBubble();
		return;
	}

	const bubbleWidth = node.offsetWidth;
	const bubbleHeight = node.offsetHeight;

	const caretX = rect.left + Math.min(CARET_INSET_PX, rect.width / 2);
	const x = Math.max(left + EDGE_PX, Math.min(caretX - CARET_INSET_PX, left + width - bubbleWidth - EDGE_PX));

	const roomBelow = top + height - rect.bottom - GAP_PX - EDGE_PX;
	const roomAbove = rect.top - top - GAP_PX - EDGE_PX;
	const below = roomBelow >= bubbleHeight || roomBelow >= roomAbove;
	const y = below ? rect.bottom + GAP_PX : rect.top - GAP_PX - bubbleHeight;

	node.classList.toggle('above', !below);
	node.style.left = `${Math.round(x)}px`;
	node.style.top = `${Math.round(y)}px`;
	node.style.setProperty('--caret-x', `${Math.round(caretX - x)}px`);
}
