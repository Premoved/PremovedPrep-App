export async function copyText(text: string): Promise<boolean> {
	if (!text) return false;

	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Permission refused, or no clipboard API: the selection fallback below still works.
	}

	return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.top = '0';
	area.style.left = '-9999px';
	area.style.fontSize = '16px';
	document.body.appendChild(area);

	const selection = document.getSelection();
	const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

	try {
		const range = document.createRange();
		range.selectNodeContents(area);
		selection?.removeAllRanges();
		selection?.addRange(range);
		area.setSelectionRange(0, text.length);

		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		area.remove();
		if (previous) {
			selection?.removeAllRanges();
			selection?.addRange(previous);
		}
	}
}
