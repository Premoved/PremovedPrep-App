export interface GameFacts {
	readonly white: string | null;
	readonly whiteElo: number | null;
	readonly black: string | null;
	readonly blackElo: number | null;
	readonly result: string | null;
	readonly year: number | null;
}

export function gamePlayers(game: GameFacts): string {
	return `${side(game.white, game.whiteElo)} – ${side(game.black, game.blackElo)}`;
}

export function gameLabel(game: GameFacts): string {
	const parts = [gamePlayers(game)];
	if (game.result && game.result !== '*') {
		parts.push(game.result);
	}
	if (game.year) {
		parts.push(String(game.year));
	}
	return parts.join(', ');
}

function side(name: string | null, elo: number | null): string {
	return `${name?.trim() || '?'}${elo ? ` (${elo})` : ''}`;
}
