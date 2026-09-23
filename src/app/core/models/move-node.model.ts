import { DrawShape } from '@lichess-org/chessground/draw';
import { Annotation, Color, PieceType, SquareName } from './chess-enums';
import { RepertoireGame } from './repertoire.model';
import { ReportPoint } from './report.model';

interface MoveNodeBase {
	fen: string;
	// Arrows and circles on this position. A circle is stored as orig === dest.
	drawings: DrawShape[];
	comment?: string;
	annotation?: Annotation;
	children: PlyNode[];
	// A study's Show/Hide solution boundary: everything after it is hidden while collapsed.
	solutionFold?: FoldState;

	modelGames?: readonly RepertoireGame[];

	reportPoint?: ReportPoint;

	// Set only on a move the Advanced Report's overlay found, never on one the user played.
	reportGames?: number;
}

export type FoldState = 'collapsed' | 'expanded';

export interface RootNode extends MoveNodeBase {
	isRoot: true;
	parent: null;
	san: 'START';
	color: Color;
}

export interface PlyNode extends MoveNodeBase {
	isRoot: false;
	parent: MoveNode;
	san: string;
	color: Color;
	piece: PieceType;
	from: SquareName;
	to: SquareName;
	promotion?: PieceType;
	fold?: FoldState;

	// True while this move exists only because a model game plays it.
	generated?: boolean;
}

export type MoveNode = RootNode | PlyNode;

export function createRootNode(fen: string, color: Color): RootNode {
	return {
		isRoot: true,
		parent: null,
		san: 'START',
		color,
		fen,
		children: [],
		drawings: [],
	};
}
