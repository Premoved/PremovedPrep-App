/** Mirror functions/search/opponent/[slug].ts and sitemap-opponents.xml.ts; keep all three in step. */
export function opponentSearchPath(name: string, fideId: number): string {
	const words = name
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return `/search/opponent/${words ? `${words}-${fideId}` : fideId}`;
}

/** The id a slug carries, or null when it carries none. */
export function fideIdFromSlug(slug: string): number | null {
	const match = /(\d+)$/.exec(slug);
	if (!match) {
		return null;
	}
	const id = Number(match[1]);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}
