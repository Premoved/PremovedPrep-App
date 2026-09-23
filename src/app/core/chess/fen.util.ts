import { Chess } from 'chess.js';
import { Key, Pieces } from '@lichess-org/chessground/types';
import { Color } from '../models/chess-enums';

export const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface CastlingRights {
	wK: boolean;
	wQ: boolean;
	bK: boolean;
	bQ: boolean;
}

export const FULL_CASTLING_RIGHTS: CastlingRights = { wK: true, wQ: true, bK: true, bQ: true };

export const NO_CASTLING_RIGHTS: CastlingRights = { wK: false, wQ: false, bK: false, bQ: false };

export function activeColor(fen: string): Color {
	return fen.split(' ')[1] === 'b' ? Color.BLACK : Color.WHITE;
}

export function pieceCount(fen: string): number {
	const placement = fen.trim().split(' ')[0] ?? '';
	let pieces = 0;
	for (const character of placement) {
		if (/[a-z]/i.test(character)) {
			pieces++;
		}
	}
	return pieces;
}

export function fullmoveField(fen: string): string {
	return fen.split(' ')[5] || '1';
}

export function withSwappedTurn(fen: string): string {
	const fields = fen.split(' ');
	fields[1] = fields[1] === 'w' ? 'b' : 'w';
	fields[3] = '-';
	return fields.join(' ');
}

function hasPiece(pieces: Pieces, square: string, role: string, color: string): boolean {
	const piece = pieces.get(square as Key);
	return !!piece && piece.role === role && piece.color === color;
}

// Emits a right only when the king and matching rook are still on their home squares.
export function castlingField(rights: CastlingRights, pieces: Pieces): string {
	let field = '';
	if (rights.wK && hasPiece(pieces, 'e1', 'king', 'white') && hasPiece(pieces, 'h1', 'rook', 'white')) field += 'K';
	if (rights.wQ && hasPiece(pieces, 'e1', 'king', 'white') && hasPiece(pieces, 'a1', 'rook', 'white')) field += 'Q';
	if (rights.bK && hasPiece(pieces, 'e8', 'king', 'black') && hasPiece(pieces, 'h8', 'rook', 'black')) field += 'k';
	if (rights.bQ && hasPiece(pieces, 'e8', 'king', 'black') && hasPiece(pieces, 'a8', 'rook', 'black')) field += 'q';
	return field || '-';
}

export function castlingRightsFrom(field: string | undefined): CastlingRights {
	if (field === undefined) {
		return { ...FULL_CASTLING_RIGHTS };
	}
	return {
		wK: field.includes('K'),
		wQ: field.includes('Q'),
		bK: field.includes('k'),
		bQ: field.includes('q'),
	};
}

// Every square that could legally be an en-passant target for `turn`, plus '-', sorted.
export function enPassantCandidates(pieces: Pieces, turn: 'w' | 'b'): string[] {
	const options = new Set<string>(['-']);
	const pawnAt = (file: string, rank: number, color: 'white' | 'black'): boolean => {
		const piece = pieces.get(`${file}${rank}` as Key);
		return !!piece && piece.role === 'pawn' && piece.color === color;
	};

	pieces.forEach((piece, square) => {
		if (piece.role !== 'pawn') return;

		const file = square[0];
		const rank = Number(square[1]);
		const left = String.fromCharCode(file.charCodeAt(0) - 1);
		const right = String.fromCharCode(file.charCodeAt(0) + 1);

		if (turn === 'b' && piece.color === 'white' && rank === 4) {
			if (pawnAt(left, 4, 'black') || pawnAt(right, 4, 'black')) options.add(`${file}3`);
		}

		if (turn === 'w' && piece.color === 'black' && rank === 5) {
			if (pawnAt(left, 5, 'white') || pawnAt(right, 5, 'white')) options.add(`${file}6`);
		}
	});

	return [...options].sort();
}

export function findStructuralPositionError(pieces: Pieces): 'kings' | 'pawn-rank' | null {
	let whiteKings = 0;
	let blackKings = 0;
	let pawnOnBackRank = false;

	pieces.forEach((piece, square) => {
		if (piece.role === 'king') {
			if (piece.color === 'white') whiteKings++;
			else blackKings++;
		}
		if (piece.role === 'pawn' && (square[1] === '1' || square[1] === '8')) {
			pawnOnBackRank = true;
		}
	});

	if (whiteKings !== 1 || blackKings !== 1) return 'kings';
	if (pawnOnBackRank) return 'pawn-rank';
	return null;
}

export function isLoadableFen(fen: string): boolean {
	try {
		new Chess(fen);
		return true;
	} catch {
		return false;
	}
}

export function isSideNotToMoveInCheck(fen: string): boolean {
	try {
		return new Chess(withSwappedTurn(fen)).inCheck();
	} catch {
		return false;
	}
}
