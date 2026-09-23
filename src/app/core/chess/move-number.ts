import { Color } from '../models/chess-enums';
import { MoveNode } from '../models/move-node.model';
import { fullmoveField } from './fen.util';

/** Move label out of context: '12.' for white, '12...' for black. */
export function moveNumberPrefix(node: MoveNode): string {
	if (node.isRoot) return '';
	const moveNumber = fullmoveField(node.parent.fen);
	return node.color === Color.BLACK ? `${moveNumber}...` : `${moveNumber}.`;
}
