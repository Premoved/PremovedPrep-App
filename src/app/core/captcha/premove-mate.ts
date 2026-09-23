import { Chess } from 'chess.js';
import { Key } from '@lichess-org/chessground/types';

export type FromTo = string;

export function mateIn(fen: string): FromTo | null {
	let game: Chess;
	try {
		game = new Chess(fen);
	} catch {
		return null;
	}

	for (const move of game.moves({ verbose: true })) {
		if (move.promotion) {
			continue;
		}
		game.move(move);
		const mate = game.isCheckmate();
		game.undo();
		if (mate) {
			return move.from + move.to;
		}
	}
	return null;
}

export interface AfterBlack {
	readonly fen: string;
	readonly dests: Map<Key, Key[]>;
}

export function playBlack(fen: string, blackMove: FromTo): AfterBlack | null {
	try {
		const game = new Chess(fen);
		game.move({ from: blackMove.slice(0, 2), to: blackMove.slice(2, 4), promotion: 'q' });

		const dests = new Map<Key, Key[]>();
		for (const move of game.moves({ verbose: true })) {
			const from = move.from as Key;
			const to = move.to as Key;
			const existing = dests.get(from);
			if (existing) {
				if (!existing.includes(to)) {
					existing.push(to);
				}
			} else {
				dests.set(from, [to]);
			}
		}
		return { fen: game.fen(), dests };
	} catch {
		return null;
	}
}

export function isMateIn(fen: string, move: FromTo): boolean {
	try {
		const game = new Chess(fen);
		game.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: 'q' });
		return game.isCheckmate();
	} catch {
		return false;
	}
}

export function afterMove(fen: string, move: FromTo): string | null {
	try {
		const game = new Chess(fen);
		game.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: 'q' });
		return game.fen();
	} catch {
		return null;
	}
}

export function anyMove(fen: string): FromTo | null {
	try {
		const moves = new Chess(fen).moves({ verbose: true });
		if (moves.length === 0) {
			return null;
		}
		const move = moves[Math.floor(Math.random() * moves.length)];
		return move.from + move.to;
	} catch {
		return null;
	}
}

export function sanOf(fen: string, move: FromTo): string | null {
	try {
		const game = new Chess(fen);
		return game.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: 'q' }).san;
	} catch {
		return null;
	}
}
