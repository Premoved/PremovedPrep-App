export enum PieceType {
	PAWN = 'P',
	KNIGHT = 'N',
	BISHOP = 'B',
	ROOK = 'R',
	QUEEN = 'Q',
	KING = 'K',
}

export enum Color {
	WHITE = 'w',
	BLACK = 'b',
}

/** Reserved for the training features. Not used by the board. */
export enum Category {
	MIXED = 'MIXED',
	M2 = 'M2',
	M3 = 'M3',
	M4PLUS = 'M4PLUS',
	MATES = 'MATES',
	STUDIES = 'STUDIES',
	SELFMATE = 'SELFMATE',
	HELPMATE = 'HELPMATE',
}

export enum BoardColumn {
	A = 'a',
	B = 'b',
	C = 'c',
	D = 'd',
	E = 'e',
	F = 'f',
	G = 'g',
	H = 'h',
}

export enum BoardRow {
	R1 = '1',
	R2 = '2',
	R3 = '3',
	R4 = '4',
	R5 = '5',
	R6 = '6',
	R7 = '7',
	R8 = '8',
}

export type SquareName = `${BoardColumn}${BoardRow}`;

export enum Annotation {
	EMPTY = '\u2205',
	EQUAL_POSITION = '\u003D',
	ONLY_MOVE = '\u25FB',
	ZUGZWANG = '\u2299',
	WITH_THE_IDEA = '\u2206',
	UNCLEAR_POSITION = '\u221E',

	GOOD_MOVE = '\u0021',
	MISTAKE = '\u003F',
	BRILLIANT_MOVE = '\u203C',
	BLUNDER = '\u2047',
	INTERESTING_MOVE = '\u2049',
	DUBIOUS_MOVE = '\u2048',

	WHITE_IS_SLIGHTLY_BETTER = '\u2A72',
	BLACK_IS_SLIGHTLY_BETTER = '\u2A71',
	WHITE_IS_BETTER = '\u00B1',
	BLACK_IS_BETTER = '\u2213',
	WHITE_IS_WINNING = '\u002B\u2212',
	BLACK_IS_WINNING = '\u2212\u002B',

	NOVELTY = '\u004E',
	DEVELOPMENT = '\u2191\u2191',
	INITIATIVE = '\u2191',
	ATTACK = '\u2192',
	COUNTERPLAY = '\u21C6',
	WITH_COMPENSATION = '\u003D\u2212',
}
