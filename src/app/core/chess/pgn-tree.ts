import { Chess } from 'chess.js';

// Port of the backend's PgnTree: one parser, used both by the repertoire linker and the Advanced
// Report's book, so a game cannot attach to one and not the other over a parsing difference.
export interface PgnTreeNode {
	readonly parent: PgnTreeNode | null;
	readonly uci: string | null;
	readonly san: string | null;
	readonly fen: string;
	readonly epd: string;
	readonly ply: number;
	readonly children: PgnTreeNode[];
}

// Ceiling on how much of one document is read, counted in nodes.
const MAX_NODES = 20_000;

export const STANDARD_EPD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

export function parsePgnTree(pgn: string | null, startFen: string | null): PgnTreeNode {
	const start = boardAt(startFen);
	const root: PgnTreeNode = {
		parent: null,
		uci: null,
		san: null,
		fen: start.fen(),
		epd: epdOf(start),
		ply: 0,
		children: [],
	};

	if (pgn === null || pgn.trim().length === 0) {
		return root;
	}

	let node = root;
	const branchPoints: PgnTreeNode[] = [];
	let nodes = 0;

	for (const token of movetextTokens(pgn)) {
		if (nodes >= MAX_NODES) {
			break;
		}

		if (token === '(') {
			// A variation replaces the move just played, so it hangs off that move's parent.
			branchPoints.push(node);
			node = node.parent ?? root;
			continue;
		}
		if (token === ')') {
			// An unbalanced ')' is a broken file, not a reason to throw.
			node = branchPoints.pop() ?? root;
			continue;
		}

		const board = boardAtFen(node.fen);
		const move = tryMove(board, token);
		if (move === null) {
			continue;
		}

		const existing = childByUci(node, move.uci);
		if (existing !== undefined) {
			node = existing;
			continue;
		}

		const child: PgnTreeNode = {
			parent: node,
			uci: move.uci,
			san: move.san,
			fen: board.fen(),
			epd: epdOf(board),
			ply: node.ply + 1,
			children: [],
		};
		node.children.push(child);
		node = child;
		nodes++;
	}

	return root;
}

export function childByUci(node: PgnTreeNode, uci: string): PgnTreeNode | undefined {
	return node.children.find((child) => child.uci === uci);
}

export function pathOf(node: PgnTreeNode): string[] {
	const path: string[] = [];
	for (let current: PgnTreeNode | null = node; current?.uci != null; current = current.parent) {
		path.unshift(current.uci);
	}
	return path;
}

export function mainlineOf(root: PgnTreeNode): PgnTreeNode[] {
	const line: PgnTreeNode[] = [];
	for (let node = root; node.children.length > 0; node = node.children[0]) {
		line.push(node.children[0]);
	}
	return line;
}

export function movetextTokens(pgn: string): string[] {
	const text = pgn
		.replace(/^[ \t]*\[[^\]]*][ \t]*$/gm, ' ')
		.replace(/\{[^}]*}/g, ' ')
		.replace(/;[^\n]*/g, ' ')
		.replace(/\$\d+/g, ' ')
		.replace(/([()])/g, ' $1 ');

	const tokens: string[] = [];
	for (const raw of text.split(/\s+/)) {
		const token = raw.trim();
		if (token.length === 0) {
			continue;
		}
		if (token === '(' || token === ')') {
			tokens.push(token);
			continue;
		}
		const san = cleanSan(token);
		if (san.length > 0) {
			tokens.push(san);
		}
	}
	return tokens;
}

export function cleanSan(token: string): string {
	let san = token.replace(/[?!]+/g, '').trim();

	if (/^[0O](-[0O]){1,2}[+#]?$/.test(san)) {
		san = san.replace(/0/g, 'O');
	}
	if (/^\d+\.*$/.test(san) || ['1-0', '0-1', '1/2-1/2', '1/2', '*'].includes(san)) {
		return '';
	}
	return san.replace(/^\d+\.{1,3}/, '');
}

// UCI (from+to) is the join key: two writers spell the same move differently ("0-0" vs "O-O",
// "exd5" vs "ed"), but from-square plus to-square agree. SAN is kept because it draws better.
export function tryMove(board: Chess, san: string): { uci: string; san: string } | null {
	try {
		const move = board.move(san);
		return { uci: `${move.from}${move.to}${move.promotion ?? ''}`, san: move.san };
	} catch {
		return null;
	}
}

export function boardAt(startFen: string | null): Chess {
	try {
		return startFen ? new Chess(startFen) : new Chess();
	} catch {
		return new Chess();
	}
}

export function boardAtFen(fen: string): Chess {
	return boardAt(fen);
}

export function epdOf(board: Chess): string {
	return board.fen().split(' ').slice(0, 4).join(' ');
}
