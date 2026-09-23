import { Role } from '@lichess-org/chessground/types';
import { PieceType } from '../models/chess-enums';

const ROLE_BY_LETTER: Readonly<Record<string, Role>> = {
	p: 'pawn',
	n: 'knight',
	b: 'bishop',
	r: 'rook',
	q: 'queen',
	k: 'king',
};

export function roleFromLetter(letter: string): Role {
	return ROLE_BY_LETTER[letter.toLowerCase()] ?? 'pawn';
}

export function roleFromPieceType(type: PieceType): Role {
	return roleFromLetter(type);
}

export function pieceTypeFromLetter(letter: string): PieceType {
	const upper = letter.toUpperCase();
	return PIECE_TYPES.has(upper) ? (upper as PieceType) : PieceType.PAWN;
}

const PIECE_TYPES = new Set<string>(Object.values(PieceType));

// Class list chessground's stylesheet expects on a <piece> element.
export function pieceCssClasses(code: string): string {
	const color = code[0] === 'w' ? 'white' : 'black';
	return `piece ${color} ${roleFromLetter(code[1])}`;
}
