import { describe, expect, it } from 'vitest';
import { PieceType } from '../models/chess-enums';
import { pieceCssClasses, pieceTypeFromLetter, roleFromLetter, roleFromPieceType } from './piece-codec';

describe('piece-codec', () => {
	it('maps every piece type to a chessground role', () => {
		expect(Object.values(PieceType).map(roleFromPieceType)).toEqual([
			'pawn',
			'knight',
			'bishop',
			'rook',
			'queen',
			'king',
		]);
	});

	it('is case-insensitive', () => {
		expect(roleFromLetter('N')).toBe('knight');
		expect(roleFromLetter('n')).toBe('knight');
	});

	it('falls back to pawn for an unknown letter', () => {
		expect(roleFromLetter('x')).toBe('pawn');
		expect(pieceTypeFromLetter('x')).toBe(PieceType.PAWN);
	});

	it('round-trips letter -> piece type -> role', () => {
		for (const letter of ['p', 'n', 'b', 'r', 'q', 'k']) {
			expect(roleFromPieceType(pieceTypeFromLetter(letter))).toBe(roleFromLetter(letter));
		}
	});

	it('builds the class list chessground styles expect', () => {
		expect(pieceCssClasses('wK')).toBe('piece white king');
		expect(pieceCssClasses('bP')).toBe('piece black pawn');
	});

	it('covers the promotion picker letters', () => {
		expect(['q', 'n', 'r', 'b'].map(roleFromLetter)).toEqual(['queen', 'knight', 'rook', 'bishop']);
	});
});
