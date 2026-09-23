export interface PieceSet {
	readonly id: string;
	readonly name: string;
	readonly bundled?: boolean;
}

export const PIECE_ASSET_ROOT = 'piece';

export const DEFAULT_PIECE_SET = 'cburnett';

export const BUNDLED_PIECE_SET: PieceSet = { id: DEFAULT_PIECE_SET, name: 'Cburnett', bundled: true };

// Names for the sets tools/fetch-lichess-pieces.mjs installs. Keep the two lists in step.
const PIECE_SET_NAMES: Readonly<Record<string, string>> = {
	cburnett: 'Cburnett',
	celtic: 'Celtic',
	chessnut: 'Chessnut',
	fantasy: 'Fantasy',
	'kiwen-suwi': 'Kiwen Suwi',
	letter: 'Letter',
	merida: 'Merida',
	mpchess: 'MPChess',
	papercut: 'Papercut',
	pirouetti: 'Pirouetti',
	pixel: 'Pixel',
	rhosgfx: 'RhosGFX',
	shapes: 'Shapes',
	spatial: 'Spatial',
	totoy: 'Totoy',
};

export function prettyPieceSetName(id: string): string {
	const words = id.replace(/[-_]+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export function pieceSetFor(id: string): PieceSet {
	if (id === DEFAULT_PIECE_SET) {
		return BUNDLED_PIECE_SET;
	}
	return { id, name: PIECE_SET_NAMES[id] ?? prettyPieceSetName(id) };
}

const ROLE_LETTERS: readonly (readonly [string, string])[] = [
	['pawn', 'P'],
	['knight', 'N'],
	['bishop', 'B'],
	['rook', 'R'],
	['queen', 'Q'],
	['king', 'K'],
];

export function pieceSetCss(set: PieceSet, baseUrl: string): string {
	if (set.bundled) {
		return '';
	}

	const rules: string[] = [];
	for (const [role, letter] of ROLE_LETTERS) {
		for (const [colour, prefix] of [
			['white', 'w'],
			['black', 'b'],
		]) {
			rules.push(
				`.cg-wrap piece.${role}.${colour} { background-image: url('${baseUrl}${PIECE_ASSET_ROOT}/${set.id}/${prefix}${letter}.svg'); }`,
			);
		}
	}
	return rules.join('\n');
}
