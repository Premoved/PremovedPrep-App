const EDGE_MARGIN = 8;

export function fitOnScreen(
	x: number,
	y: number,
	size: { readonly width: number; readonly height: number },
	margin = EDGE_MARGIN,
): { x: number; y: number } {
	return {
		x: Math.max(margin, Math.min(x, window.innerWidth - size.width - margin)),
		y: Math.max(margin, Math.min(y, window.innerHeight - size.height - margin)),
	};
}
