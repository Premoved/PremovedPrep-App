import { beforeEach, describe, expect, it } from 'vitest';
import { PgnParserService } from './pgn-parser.service';
import { moveNumberPrefix } from './move-number';

describe('moveNumberPrefix', () => {
	let parser: PgnParserService;

	beforeEach(() => {
		parser = new PgnParserService();
	});

	const parseTree = (pgn: string) => parser.parse(pgn).root;

	it('is empty for the root, which has no move', () => {
		expect(moveNumberPrefix(parseTree('1. e4 *'))).toBe('');
	});

	it('numbers a white move plainly', () => {
		const e4 = parseTree('1. e4 e5 2. Nf3 *').children[0];
		expect(moveNumberPrefix(e4)).toBe('1.');
	});

	it('numbers a black move with an ellipsis', () => {
		const e5 = parseTree('1. e4 e5 2. Nf3 *').children[0].children[0];
		expect(moveNumberPrefix(e5)).toBe('1...');
	});

	it('takes the number from the parent position, so it advances after black', () => {
		const nf3 = parseTree('1. e4 e5 2. Nf3 *').children[0].children[0].children[0];
		expect(moveNumberPrefix(nf3)).toBe('2.');
	});

	it('labels the variations the picker actually shows', () => {
		const tree = parseTree('1. e4 e5 2. Nf3 (2. Bc4) (2. d4) *');
		const branches = tree.children[0].children[0].children;
		expect(branches.map(moveNumberPrefix)).toEqual(['2.', '2.', '2.']);
	});

	it('handles a game starting from a black-to-move position', () => {
		const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
		const e5 = parseTree(`[FEN "${fen}"]\n\n1... e5 *`).children[0];
		expect(moveNumberPrefix(e5)).toBe('1...');
	});
});
