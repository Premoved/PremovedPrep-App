import { PlyNode } from '../models/move-node.model';

export function uciOf(node: PlyNode): string {
	return `${node.from}${node.to}${node.promotion ? node.promotion.toLowerCase() : ''}`;
}

export function parseUci(uci: string): { from: string; to: string; promotion?: string } | null {
	if (uci.length < 4) {
		return null;
	}
	const promotion = uci.slice(4, 5).toLowerCase();
	return {
		from: uci.slice(0, 2),
		to: uci.slice(2, 4),
		promotion: promotion.length === 1 ? promotion : undefined,
	};
}
