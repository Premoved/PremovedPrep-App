import { beforeEach, describe, expect, it } from 'vitest';
import { Annotation } from '../models/chess-enums';
import { MoveNode } from '../models/move-node.model';
import { formatGameDate, hasGameHeaders } from './game-headers';
import { PgnParserService } from './pgn-parser.service';
import { PgnSerializerService } from './pgn-serializer.service';

function fingerprint(node: MoveNode): unknown {
	return {
		san: node.san,
		annotation: node.annotation ?? null,
		comment: node.comment ?? null,
		// Sorted because the serialiser writes circles before arrows, so a round trip may reorder them.
		drawings: (node.drawings ?? [])
			.map((shape) => `${shape.brush}:${shape.orig}${shape.dest && shape.dest !== shape.orig ? `-${shape.dest}` : ''}`)
			.sort(),
		children: node.children.map(fingerprint),
	};
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const RICH_PGN = [
	`[FEN "${START_FEN}"]`,
	'[Variant "From Position"]',
	'',
	'1. e4 $1 e5 { [%cal Gg1f3,Rf1c4] [%csl Bd5] a plan } 2. Nf3 (2. Bc4 Nf6 (2... Nc6 $5) 3. d3) Nc6 3. Bb5 *',
].join('\n');

describe('PGN parser and serializer', () => {
	let parser: PgnParserService;
	let serializer: PgnSerializerService;

	beforeEach(() => {
		parser = new PgnParserService();
		serializer = new PgnSerializerService();
	});

	const parseTree = (pgn: string) => parser.parse(pgn).root;

	describe('game headers', () => {
		it('reads the roster the notation header shows', () => {
			const { headers } = parser.parse(
				[
					'[Event "World Youth Girls U18"]',
					'[Site "Mamaia ROU"]',
					'[Date "2022.09.13"]',
					'[Round "8.12"]',
					'[White "Lehaci,Miruna Daria"]',
					'[Black "Velea,Anne-Marie"]',
					'[Result "1-0"]',
					'[WhiteElo "2199"]',
					'[BlackElo "1954"]',
					'[ECO "B21"]',
					'[Annotator "Nanu"]',
					'',
					'1. e4 *',
				].join('\n'),
			);

			expect(headers.white).toBe('Lehaci,Miruna Daria');
			expect(headers.whiteElo).toBe('2199');
			expect(headers.black).toBe('Velea,Anne-Marie');
			expect(headers.result).toBe('1-0');
			expect(headers.eco).toBe('B21');
			expect(headers.round).toBe('8.12');
			expect(headers.annotator).toBe('Nanu');
			expect(hasGameHeaders(headers)).toBe(true);
		});

		it('drops the placeholder tags exporters emit for unknown values', () => {
			const { headers } = parser.parse(
				['[Event "?"]', '[Site "?"]', '[Date "????.??.??"]', '[Round "-"]', '[Result "*"]', '', '1. e4 *'].join('\n'),
			);

			expect(headers.event).toBeUndefined();
			expect(headers.date).toBeUndefined();
			expect(headers.round).toBeUndefined();
			expect(headers.result).toBeUndefined();
			expect(hasGameHeaders(headers)).toBe(false);
		});

		it('has no headers at all when the PGN has no tags', () => {
			expect(hasGameHeaders(parser.parse('1. e4 *').headers)).toBe(false);
		});

		it('formats a PGN date day-first, dropping unknown components', () => {
			expect(formatGameDate('2022.09.13')).toBe('13.09.2022');
			expect(formatGameDate('2022.??.??')).toBe('2022');
			expect(formatGameDate(undefined)).toBe('');
		});
	});

	it('round-trips a tree with variations, NAGs, comments and drawings', () => {
		const tree = parseTree(RICH_PGN);
		const pgn = serializer.serialize(tree);
		expect(fingerprint(parseTree(pgn))).toEqual(fingerprint(tree));
	});

	it('reaches a fixed point after one serialization', () => {
		const pgn = serializer.serialize(parseTree(RICH_PGN));
		expect(serializer.serialize(parseTree(pgn))).toBe(pgn);
	});

	describe('parsing', () => {
		it('keeps NAGs on the move they follow', () => {
			const tree = parseTree(RICH_PGN);
			expect(tree.children[0].annotation).toBe(Annotation.GOOD_MOVE);
		});

		it('strips drawing payloads out of the comment text', () => {
			const e5 = parseTree(RICH_PGN).children[0].children[0];
			expect(e5.comment).toBe('a plan');
			expect(e5.drawings).toHaveLength(3);
		});

		it('stores a circle as a zero-length arrow', () => {
			const e5 = parseTree(RICH_PGN).children[0].children[0];
			const circle = e5.drawings?.find((shape) => shape.orig === shape.dest);
			expect(circle).toEqual({ orig: 'd5', dest: 'd5', brush: 'blue' });
		});

		it('attaches a variation as a sibling of the move it replaces', () => {
			const e5 = parseTree(RICH_PGN).children[0].children[0];
			expect(e5.children.map((node) => node.san)).toEqual(['Nf3', 'Bc4']);
		});

		it('attaches a nested variation to the grandparent, not the previous move', () => {
			const bc4 = parseTree(RICH_PGN).children[0].children[0].children[1];
			expect(bc4.children.map((node) => node.san)).toEqual(['Nf6', 'Nc6']);
		});

		it('skips an unreadable move instead of abandoning the import', () => {
			const tree = parseTree('1. e4 Zz9 e5 *');
			expect(tree.children[0].children.map((node) => node.san)).toEqual(['e5']);
		});

		it('does not treat a result token as a move', () => {
			const tree = parseTree('1. e4 e5 1-0');
			expect(tree.children[0].children.map((node) => node.san)).toEqual(['e5']);
		});

		// The black king on e5 keeps the promotion from being check, so chess.js does not normalise the SAN.
		const PROMOTION_FEN = '8/P7/8/4k3/8/8/8/4K3 w - - 0 1';

		it('does not annotate a promotion', () => {
			const promotion = parseTree(`[FEN "${PROMOTION_FEN}"]\n\n1. a8=Q *`).children[0];
			expect(promotion.san).toBe('a8=Q');
			expect(promotion.annotation).toBeUndefined();
		});

		it('keeps an evaluation attached to a promotion', () => {
			const promotion = parseTree(`[FEN "${PROMOTION_FEN}"]\n\n1. a8=Q! *`).children[0];
			expect(promotion.annotation).toBe(Annotation.GOOD_MOVE);
		});

		it('does not emit an equality NAG when re-exporting a promotion', () => {
			const pgn = serializer.serialize(parseTree(`[FEN "${PROMOTION_FEN}"]\n\n1. a8=Q *`));
			expect(pgn).toContain('a8=Q');
			expect(pgn).not.toContain('$10');
		});

		it('honours a FEN header', () => {
			const fen = '8/8/8/4k3/8/8/4K3/8 w - - 0 1';
			expect(parseTree(`[FEN "${fen}"]\n\n1. Kd2 *`).fen).toBe(fen);
		});

		it('falls back to the standard start position with no FEN header', () => {
			expect(parseTree('1. e4 *').fen).toBe(START_FEN);
		});
	});

	describe('serializing', () => {
		it('returns an empty string for a missing root', () => {
			expect(serializer.serialize(null)).toBe('');
		});

		it('terminates the game as unfinished', () => {
			expect(serializer.serialize(parseTree('1. e4 *')).endsWith(' *')).toBe(true);
		});

		it('numbers a black move that opens a variation with the ellipsis form', () => {
			const pgn = serializer.serialize(parseTree(RICH_PGN));
			expect(pgn).toContain('2... Nc6');
		});

		it('emits circles as %csl and arrows as %cal', () => {
			const pgn = serializer.serialize(parseTree(RICH_PGN));
			expect(pgn).toContain('[%csl Bd5]');
			expect(pgn).toContain('[%cal Gg1f3,Rf1c4]');
		});
	});
});
