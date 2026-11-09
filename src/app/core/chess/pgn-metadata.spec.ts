import { describe, expect, it } from 'vitest';
import {
	convertTypeTo,
	deriveFields,
	importTypeFor,
	parsePgn,
	splitPgn,
	withLegacyNames,
	withTag,
} from './pgn-metadata';
import { compareItems } from '../services/item-sort';
import { ItemSummary, itemTypeOf } from '../models/collection.model';
import { readPayload, writePayload } from '../services/item-payload';

// These cases mirror what PgnDocument, CollectionService.fieldsFor and ItemSort each enforced server-side.
const GAME = `[Event "Tata Steel"]
[Site "Wijk aan Zee"]
[Date "2024.01.20"]
[Round "7"]
[White "Carlsen, Magnus"]
[Black "Giri, Anish"]
[Result "1-0"]
[WhiteElo "2830"]
[BlackElo "2760"]
[ECO "D37"]

1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 Be7 {a solid choice} 5. Bf4 O-O (5... c5 6. dxc5) 6. e3 1-0
`;

const STUDY = `[Event "Mate in two"]
[Annotator "Armand"]
[FEN "8/8/8/8/8/5K2/6Q1/6k1 w - - 0 1"]
[SetUp "1"]

1. Qg3 *
`;

describe('reading a PGN', () => {
	it('reads the tag pairs', () => {
		expect(parsePgn(GAME).tags['White']).toBe('Carlsen, Magnus');
	});

	it('counts the mainline and not the variations', () => {
		// Six moves of mainline, eleven half-moves; the (5... c5 6. dxc5) is not part of it.
		expect(parsePgn(GAME).plyCount).toBe(11);
	});

	it('treats PGN\'s "?" as absent rather than as a value', () => {
		const unknown = deriveFields(parsePgn('[White "?"]\n[Black "?"]\n[Date "????.??.??"]\n\n*'));
		expect([unknown.white, unknown.black, unknown.date, unknown.year]).toEqual([null, null, null, null]);
	});
});

describe('deriving the columns', () => {
	const fields = deriveFields(parsePgn(GAME));

	it('derives the players and their ratings', () => {
		expect([fields.white, fields.whiteElo]).toEqual(['Carlsen, Magnus', 2830]);
		expect([fields.black, fields.blackElo]).toEqual(['Giri, Anish', 2760]);
	});

	it('derives the result, the event and the date', () => {
		expect(fields.result).toBe('1-0');
		expect(fields.event).toBe('Tata Steel');
		expect(fields.date).toBe('2024-01-20');
		expect(fields.year).toBe(2024);
	});

	it('has no starting position for a game from the opening array', () => {
		expect(fields.startFen).toBeNull();
	});

	// The type is a behaviour, not a shape: a study is read exactly like a game.
	it('reads a study with the same columns as a game', () => {
		const study = deriveFields(parsePgn(STUDY));
		expect([study.event, study.annotator]).toEqual(['Mate in two', 'Armand']);
		expect([study.white, study.black, study.result]).toEqual([null, null, null]);
		expect(study.startFen).toBe('8/8/8/8/8/5K2/6Q1/6k1 w - - 0 1');
	});
});

describe('the ECO code', () => {
	it('comes from the file when the file has one', () => {
		expect(deriveFields(parsePgn(GAME)).eco).toBe('D37');
	});

	// Classifying an untagged line would mean sending its moves to the server for lookup; refused on
	// principle, so an untagged line is shown without a code rather than sent upstairs.
	it('is absent when the file has none', () => {
		expect(deriveFields(parsePgn('1. e4 e5 2. Nf3 *')).eco).toBeNull();
	});
});

describe('setting a tag', () => {
	it('replaces a tag the file already has, and nothing else', () => {
		const pgn = withTag(GAME, 'White', 'Someone');
		expect(parsePgn(pgn).tags['White']).toBe('Someone');
		expect(parsePgn(pgn).tags['Black']).toBe('Giri, Anish');
		expect(parsePgn(pgn).plyCount).toBe(11);
	});

	it('adds a missing tag after the others', () => {
		const pgn = withTag(STUDY, 'White', 'Someone');
		expect(parsePgn(pgn).tags['White']).toBe('Someone');
		expect(parsePgn(pgn).tags['FEN']).toBe('8/8/8/8/8/5K2/6Q1/6k1 w - - 0 1');
	});

	it('gives a file with no tags its blank line', () => {
		const pgn = withTag('1. e4 *', 'Event', 'Training');
		expect(pgn).toBe('[Event "Training"]\n\n1. e4 *');
		expect(parsePgn(pgn).plyCount).toBe(1);
	});

	it('escapes quotes and leaves a blank value alone', () => {
		expect(parsePgn(withTag('*', 'Event', 'The "Immortal"')).tags['Event']).toBe('The "Immortal"');
		expect(withTag(GAME, 'White', '  ')).toBe(GAME);
	});
});

describe('an entry saved with a title and an author', () => {
	it('shows them as Event and Annotator when the file has neither', () => {
		const fields = deriveFields(parsePgn(withLegacyNames('[Event "?"]\n\n1. e4 *', 'Anti-Sicilian', 'Coach')));
		expect([fields.event, fields.annotator]).toEqual(['Anti-Sicilian', 'Coach']);
	});

	it("never overwrites the file's own tags", () => {
		expect(withLegacyNames(STUDY, 'Another title', 'Someone else')).toBe(STUDY);
	});

	it('is read that way from a sealed payload, and written back without them', () => {
		const old = JSON.stringify({ v: 1, pgn: '1. d4 *', title: 'London', author: 'Coach' });
		const read = readPayload(old);
		expect(deriveFields(parsePgn(read.pgn)).event).toBe('London');
		expect(JSON.parse(writePayload(read))).toEqual({ v: 1, pgn: read.pgn });
	});
});

describe('splitting a file', () => {
	it('splits on a tag pair that follows movetext', () => {
		expect(splitPgn(`${GAME}\n${STUDY}\n${GAME}`)).toHaveLength(3);
	});

	it('splits on a tag pair that follows a closed roster', () => {
		expect(splitPgn('[Event "A"]\n\n[Event "B"]\n\n')).toHaveLength(2);
	});

	it('finds one game in one game, and none in nothing', () => {
		expect(splitPgn(GAME)).toHaveLength(1);
		expect(splitPgn('   \n\n  ')).toHaveLength(0);
	});

	it('survives the byte order mark a Windows exporter leaves', () => {
		expect(splitPgn(`\uFEFF${GAME}`)).toHaveLength(1);
	});
});

describe('choosing a type for an imported game', () => {
	it('calls a game with two named players a game', () => {
		expect(importTypeFor('LIBRARY', parsePgn(GAME))).toBe('GAME');
		expect(importTypeFor('REPERTOIRE', parsePgn(GAME))).toBe('MODEL_GAME');
	});

	it('calls a set-up position a study and a bare line a game', () => {
		expect(importTypeFor('LIBRARY', parsePgn(STUDY))).toBe('STUDY');
		expect(importTypeFor('LIBRARY', parsePgn('1. e4 *'))).toBe('GAME');
	});

	it("does not count PGN's ways of writing nobody as players", () => {
		expect(importTypeFor('LIBRARY', parsePgn('[White "NN"]\n[Black "N.N."]\n\n1. e4 *'))).toBe('GAME');
		expect(importTypeFor('REPERTOIRE', parsePgn('[White "NN"]\n[Black "N.N."]\n\n1. e4 *'))).toBe('MAIN_LINE');
	});

	it('reads the retired analysis type as a game', () => {
		expect(itemTypeOf('ANALYSIS')).toBe('GAME');
		expect(itemTypeOf('STUDY')).toBe('STUDY');
	});
});

describe('converting a type for the other shelf', () => {
	it('leaves a type that already belongs alone', () => {
		expect(convertTypeTo('LIBRARY', 'GAME')).toBe('GAME');
		expect(convertTypeTo('REPERTOIRE', 'MODEL_GAME')).toBe('MODEL_GAME');
	});

	it('swaps the two game types', () => {
		expect(convertTypeTo('REPERTOIRE', 'GAME')).toBe('MODEL_GAME');
		expect(convertTypeTo('LIBRARY', 'MODEL_GAME')).toBe('GAME');
	});

	// A pair each way, so a repertoire moved to the Library and back keeps its trunk.
	it('swaps a study and a trunk', () => {
		expect(convertTypeTo('REPERTOIRE', 'STUDY')).toBe('MAIN_LINE');
		expect(convertTypeTo('LIBRARY', 'MAIN_LINE')).toBe('STUDY');
	});
});

describe('sorting a collection', () => {
	const row = (over: Partial<ItemSummary>): ItemSummary =>
		({
			id: 0,
			itemType: 'GAME',
			sortOrder: 0,
			white: null,
			whiteElo: null,
			black: null,
			blackElo: null,
			result: null,
			event: null,
			date: null,
			year: null,
			annotator: null,
			eco: null,
			plyCount: 0,
			startFen: null,
			updatedAt: '2024-01-01T00:00:00Z',
			...over,
		}) as ItemSummary;

	const items = [
		row({ id: 1, white: 'Carlsen', whiteElo: 2830, result: '1-0', plyCount: 40 }),
		row({ id: 2, white: 'Anand', whiteElo: null, result: '0-1', plyCount: 0 }),
		row({ id: 3, white: 'Bacrot', whiteElo: 2700, result: '1/2-1/2', plyCount: 20 }),
	];

	const ids = (sort: Parameters<typeof compareItems>[1], ascending?: boolean) =>
		compareItems(items, sort, ascending).map((item) => item.id);

	it('sorts by name in both directions', () => {
		expect(ids('WHITE')).toEqual([2, 3, 1]);
		expect(ids('WHITE', false)).toEqual([1, 3, 2]);
	});

	// ASC NULLS LAST and DESC NULLS LAST: absent is absent whichever way round the sort is.
	it('keeps absent values at the bottom in both directions', () => {
		expect(ids('WHITE_ELO', true)).toEqual([3, 1, 2]);
		expect(ids('WHITE_ELO', false)).toEqual([1, 3, 2]);
	});

	// NULLIF(ply_count, 0): an entry with no moves is absent, not the shortest.
	it('treats an entry with no moves as having no length', () => {
		expect(ids('MOVES', true)).toEqual([3, 1, 2]);
	});

	it('orders results the way the stored code did', () => {
		expect(ids('RESULT', true)).toEqual([2, 3, 1]);
		expect(ids('RESULT')).toEqual([1, 3, 2]);
	});

	it('groups by type, studies first or games first', () => {
		const mixed = [
			row({ id: 1, itemType: 'GAME' }),
			row({ id: 2, itemType: 'STUDY' }),
			row({ id: 3, itemType: 'GAME' }),
		];
		expect(compareItems(mixed, 'TYPE').map((item) => item.id)).toEqual([2, 1, 3]);
		expect(compareItems(mixed, 'TYPE_GAME_FIRST').map((item) => item.id)).toEqual([1, 3, 2]);
	});

	it('breaks ties on the id, so a list does not shuffle between renders', () => {
		const tied = [row({ id: 7, white: 'Same' }), row({ id: 3, white: 'Same' })];
		expect(compareItems(tied, 'WHITE').map((item) => item.id)).toEqual([3, 7]);
	});
});
