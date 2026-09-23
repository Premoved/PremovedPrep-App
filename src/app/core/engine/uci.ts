import { Chess } from 'chess.js';
import { Color } from '../models/chess-enums';

export interface EngineLine {
	readonly multipv: number;
	readonly depth: number;
	readonly cp: number | null;
	/** Moves to mate, signed towards the side to move. null for a centipawn score. */
	readonly mate: number | null;
	readonly nodes: number;
	readonly nps: number;
	readonly pv: readonly string[];
}

function intAfter(tokens: readonly string[], key: string): number | null {
	const index = tokens.indexOf(key);
	if (index === -1) return null;
	const value = Number.parseInt(tokens[index + 1] ?? '', 10);
	return Number.isNaN(value) ? null : value;
}

export function parseInfoLine(line: string): EngineLine | null {
	if (!line.startsWith('info ') || line.startsWith('info string')) return null;

	const tokens = line.split(/\s+/);
	const pvIndex = tokens.indexOf('pv');
	if (pvIndex === -1) return null;

	const cp = intAfter(tokens, 'cp');
	const mate = intAfter(tokens, 'mate');
	if (cp === null && mate === null) return null;

	const pv = tokens.slice(pvIndex + 1).filter((token) => token.length >= 4);
	if (pv.length === 0) return null;

	return {
		multipv: intAfter(tokens, 'multipv') ?? 1,
		depth: intAfter(tokens, 'depth') ?? 0,
		cp,
		mate,
		nodes: intAfter(tokens, 'nodes') ?? 0,
		nps: intAfter(tokens, 'nps') ?? 0,
		pv,
	};
}

export interface UciMove {
	readonly from: string;
	readonly to: string;
	readonly promotion?: string;
}

export function parseUciMove(uci: string): UciMove | null {
	if (uci.length < 4) return null;
	return {
		from: uci.slice(0, 2),
		to: uci.slice(2, 4),
		promotion: uci.length > 4 ? uci[4] : undefined,
	};
}

export function parseBestMove(line: string): string | null {
	if (!line.startsWith('bestmove')) return null;
	const move = line.split(/\s+/)[1];
	return move && move !== '(none)' ? move : null;
}

/** Formats the score from White's point of view, whichever side is to move. */
export function formatScore(line: EngineLine, sideToMove: Color): string {
	const perspective = sideToMove === Color.BLACK ? -1 : 1;

	if (line.mate !== null) {
		const mate = line.mate * perspective;
		return `${mate < 0 ? '-' : '+'}M${Math.abs(mate)}`;
	}

	const pawns = ((line.cp ?? 0) * perspective) / 100;
	return `${pawns > 0 ? '+' : pawns < 0 ? '-' : ''}${Math.abs(pawns).toFixed(2)}`;
}

export function pvToSan(fen: string, pv: readonly string[], limit: number): string[] {
	const game = new Chess();
	try {
		game.load(fen);
	} catch {
		return [];
	}

	const out: string[] = [];
	for (const uci of pv.slice(0, limit)) {
		const isWhite = game.turn() === 'w';
		const number = game.moveNumber();
		const prefix = isWhite ? `${number}.` : out.length === 0 ? `${number}...` : '';

		try {
			const move = game.move({
				from: uci.slice(0, 2),
				to: uci.slice(2, 4),
				promotion: uci.length > 4 ? uci[4] : undefined,
			});
			out.push(`${prefix}${move.san}`);
		} catch {
			break;
		}
	}
	return out;
}
