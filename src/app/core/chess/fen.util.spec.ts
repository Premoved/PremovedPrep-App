import { describe, expect, it } from 'vitest';
import { Piece, Pieces } from '@lichess-org/chessground/types';
import { Color } from '../models/chess-enums';
import {
	FULL_CASTLING_RIGHTS,
	activeColor,
	castlingField,
	enPassantCandidates,
	findStructuralPositionError,
	fullmoveField,
	withSwappedTurn,
} from './fen.util';

function board(entries: Record<string, Piece>): Pieces {
	return new Map(Object.entries(entries)) as Pieces;
}

const WHITE_KING: Piece = { role: 'king', color: 'white' };
const BLACK_KING: Piece = { role: 'king', color: 'black' };
const WHITE_ROOK: Piece = { role: 'rook', color: 'white' };
const WHITE_PAWN: Piece = { role: 'pawn', color: 'white' };
const BLACK_PAWN: Piece = { role: 'pawn', color: 'black' };

describe('fen.util', () => {
	describe('field readers', () => {
		it('reads the side to move', () => {
			expect(activeColor('8/8/8/8/8/8/8/8 w - - 0 1')).toBe(Color.WHITE);
			expect(activeColor('8/8/8/8/8/8/8/8 b - - 0 1')).toBe(Color.BLACK);
		});

		it('reads the fullmove counter', () => {
			expect(fullmoveField('8/8/8/8/8/8/8/8 w - - 3 17')).toBe('17');
		});

		it('falls back to move 1 for a truncated FEN', () => {
			expect(fullmoveField('8/8/8/8/8/8/8/8 w - -')).toBe('1');
		});
	});

	describe('withSwappedTurn', () => {
		it('flips the side to move and clears the en-passant field', () => {
			expect(withSwappedTurn('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2')).toBe(
				'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2',
			);
		});

		it('is its own inverse once en passant is gone', () => {
			const fen = '8/8/8/4k3/8/8/4K3/8 w - - 0 1';
			expect(withSwappedTurn(withSwappedTurn(fen))).toBe(fen);
		});

		it('leaves castling rights untouched', () => {
			expect(withSwappedTurn('8/8/8/8/8/8/8/8 w KQkq - 0 1')).toContain('KQkq');
		});
	});

	describe('castlingField', () => {
		it('emits only rights the pieces actually support', () => {
			const pieces = board({ e1: WHITE_KING, h1: WHITE_ROOK, e8: BLACK_KING });
			expect(castlingField(FULL_CASTLING_RIGHTS, pieces)).toBe('K');
		});

		it('emits a dash when nothing is available', () => {
			expect(castlingField(FULL_CASTLING_RIGHTS, board({ a4: WHITE_KING, h8: BLACK_KING }))).toBe('-');
		});

		it('respects an unticked right even when the pieces are in place', () => {
			const pieces = board({ e1: WHITE_KING, h1: WHITE_ROOK, e8: BLACK_KING });
			expect(castlingField({ ...FULL_CASTLING_RIGHTS, wK: false }, pieces)).toBe('-');
		});
	});

	describe('enPassantCandidates', () => {
		it('offers the square behind a white pawn that a black pawn can capture', () => {
			const pieces = board({ e1: WHITE_KING, e8: BLACK_KING, e4: WHITE_PAWN, d4: BLACK_PAWN });
			expect(enPassantCandidates(pieces, 'b')).toEqual(['-', 'e3']);
		});

		it('offers nothing to the side that cannot capture', () => {
			const pieces = board({ e1: WHITE_KING, e8: BLACK_KING, e4: WHITE_PAWN, d4: BLACK_PAWN });
			expect(enPassantCandidates(pieces, 'w')).toEqual(['-']);
		});

		it('offers nothing when no enemy pawn stands beside the double-stepped pawn', () => {
			const pieces = board({ e1: WHITE_KING, e8: BLACK_KING, e4: WHITE_PAWN });
			expect(enPassantCandidates(pieces, 'b')).toEqual(['-']);
		});

		it('mirrors the rule for black pawns on rank 5', () => {
			const pieces = board({ e1: WHITE_KING, e8: BLACK_KING, d5: BLACK_PAWN, e5: WHITE_PAWN });
			expect(enPassantCandidates(pieces, 'w')).toEqual(['-', 'd6']);
		});
	});

	describe('findStructuralPositionError', () => {
		it('accepts one king per side', () => {
			expect(findStructuralPositionError(board({ e1: WHITE_KING, e8: BLACK_KING }))).toBeNull();
		});

		it('rejects a missing king', () => {
			expect(findStructuralPositionError(board({ e1: WHITE_KING }))).toBe('kings');
		});

		it('rejects a duplicated king', () => {
			expect(findStructuralPositionError(board({ e1: WHITE_KING, d1: WHITE_KING, e8: BLACK_KING }))).toBe('kings');
		});

		it('rejects a pawn on rank 1 or rank 8', () => {
			expect(findStructuralPositionError(board({ e1: WHITE_KING, e8: BLACK_KING, a1: WHITE_PAWN }))).toBe('pawn-rank');
			expect(findStructuralPositionError(board({ e1: WHITE_KING, e8: BLACK_KING, a8: BLACK_PAWN }))).toBe('pawn-rank');
		});
	});
});
