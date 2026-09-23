import { describe, expect, it } from 'vitest';
import { Color } from '../models/chess-enums';
import { EngineLine, formatScore, parseBestMove, parseInfoLine, pvToSan } from './uci';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

function line(overrides: Partial<EngineLine> = {}): EngineLine {
	return { multipv: 1, depth: 20, cp: 0, mate: null, nodes: 0, nps: 0, pv: [], ...overrides };
}

describe('parseInfoLine', () => {
	it('reads a centipawn variation', () => {
		const parsed = parseInfoLine(
			'info depth 22 seldepth 30 multipv 2 score cp -35 nodes 1234567 nps 900000 time 1370 pv e7e5 g1f3',
		);

		expect(parsed).toEqual({
			multipv: 2,
			depth: 22,
			cp: -35,
			mate: null,
			nodes: 1234567,
			nps: 900000,
			pv: ['e7e5', 'g1f3'],
		});
	});

	it('reads a mate score', () => {
		expect(parseInfoLine('info depth 12 score mate -3 pv h5f7')?.mate).toBe(-3);
	});

	it('treats a missing multipv as line 1, which is how a single-PV search reports', () => {
		expect(parseInfoLine('info depth 4 score cp 12 pv e2e4')?.multipv).toBe(1);
	});

	it('ignores the info lines that carry no variation', () => {
		expect(parseInfoLine('info depth 1 seldepth 1 nodes 20 nps 20000 time 1')).toBeNull();
		expect(parseInfoLine('info currmove e2e4 currmovenumber 1')).toBeNull();
		expect(parseInfoLine('info depth 5 score cp 20 upperbound')).toBeNull();
	});

	it('never reads an info string, whatever it happens to contain', () => {
		expect(parseInfoLine('info string NNUE evaluation using pv score cp nonsense')).toBeNull();
	});

	it('ignores anything that is not an info line', () => {
		expect(parseInfoLine('bestmove e2e4')).toBeNull();
		expect(parseInfoLine('readyok')).toBeNull();
	});
});

describe('parseBestMove', () => {
	it('takes the move and drops the ponder', () => {
		expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4');
	});

	it('reports no move in a finished game', () => {
		expect(parseBestMove('bestmove (none)')).toBeNull();
	});
});

describe('formatScore', () => {
	it('leaves a white-to-move score alone', () => {
		expect(formatScore(line({ cp: 34 }), Color.WHITE)).toBe('+0.34');
	});

	it('flips a black-to-move score to White’s point of view', () => {
		expect(formatScore(line({ cp: 100 }), Color.BLACK)).toBe('-1.00');
	});

	it('prints a level position without a sign', () => {
		expect(formatScore(line({ cp: 0 }), Color.WHITE)).toBe('0.00');
	});

	it('flips a mate score too', () => {
		expect(formatScore(line({ cp: null, mate: 3 }), Color.WHITE)).toBe('+M3');
		expect(formatScore(line({ cp: null, mate: 3 }), Color.BLACK)).toBe('-M3');
	});
});

describe('pvToSan', () => {
	it('numbers from the position the line starts in', () => {
		expect(pvToSan(START_FEN, ['e2e4', 'e7e5', 'g1f3'], 10)).toEqual(['1.e4', 'e5', '2.Nf3']);
	});

	it('opens with the ellipsis form when Black moves first', () => {
		expect(pvToSan(BLACK_TO_MOVE, ['e7e5', 'g1f3'], 10)).toEqual(['1...e5', '2.Nf3']);
	});

	it('stops at the first move the position rejects rather than throwing', () => {
		expect(pvToSan(START_FEN, ['e2e4', 'a1a8', 'e7e5'], 10)).toEqual(['1.e4']);
	});

	it('honours the limit', () => {
		expect(pvToSan(START_FEN, ['e2e4', 'e7e5', 'g1f3'], 2)).toHaveLength(2);
	});

	it('returns nothing for a position it cannot load', () => {
		expect(pvToSan('not a fen', ['e2e4'], 10)).toEqual([]);
	});
});
