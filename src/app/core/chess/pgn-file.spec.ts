import { describe, expect, it } from 'vitest';
import { DEFAULT_FEN } from './fen.util';
import { gameHeadersFromTags } from './game-headers';
import { composePgnFile } from './pgn-file';

const CUSTOM_FEN = '8/8/8/4k3/8/8/4K3/4R3 w - - 0 1';

// The tags a Lichess export carries beyond the seven the roster requires.
const IMPORTED = {
	Event: 'Rated blitz game',
	Site: 'https://lichess.org/abcd1234',
	Date: '2026.02.11',
	Round: '?',
	White: 'alice',
	Black: 'bob',
	Result: '1-0',
	UTCDate: '2026.02.11',
	UTCTime: '19:04:12',
	WhiteRatingDiff: '+6',
	BlackRatingDiff: '-6',
	Opening: 'Sicilian Defense',
	PlyCount: '41',
};

function tagsOf(pgn: string): Record<string, string> {
	const found: Record<string, string> = {};
	for (const [, name, value] of pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) {
		found[name] = value;
	}
	return found;
}

describe('composePgnFile', () => {
	it('gives back the tags it was not asked about', () => {
		const headers = gameHeadersFromTags(IMPORTED);
		const tags = tagsOf(composePgnFile({ headers, startFen: DEFAULT_FEN, movetext: '1. e4 *' }));

		expect(tags['UTCTime']).toBe('19:04:12');
		expect(tags['Opening']).toBe('Sicilian Defense');
		expect(tags['WhiteRatingDiff']).toBe('+6');
	});

	it('drops PlyCount, because editing the moves makes it a lie', () => {
		const headers = gameHeadersFromTags(IMPORTED);
		const tags = tagsOf(composePgnFile({ headers, startFen: DEFAULT_FEN, movetext: '1. e4 *' }));

		expect(tags['PlyCount']).toBeUndefined();
	});

	it('writes no FEN from the opening array', () => {
		const tags = tagsOf(
			composePgnFile({ headers: gameHeadersFromTags(IMPORTED), startFen: DEFAULT_FEN, movetext: '*' }),
		);

		expect(tags['FEN']).toBeUndefined();
		expect(tags['SetUp']).toBeUndefined();
		expect(tags['Variant']).toBeUndefined();
	});

	it('writes FEN, SetUp and Variant for a position that was set up', () => {
		const tags = tagsOf(
			composePgnFile({ headers: gameHeadersFromTags(IMPORTED), startFen: CUSTOM_FEN, movetext: '*' }),
		);

		expect(tags['FEN']).toBe(CUSTOM_FEN);
		expect(tags['SetUp']).toBe('1');
		expect(tags['Variant']).toBe('From Position');
	});

	it('keeps a real variant rather than calling it From Position', () => {
		const headers = gameHeadersFromTags({ ...IMPORTED, Variant: 'Chess960' });
		const tags = tagsOf(composePgnFile({ headers, startFen: CUSTOM_FEN, movetext: '*' }));

		expect(tags['Variant']).toBe('Chess960');
	});

	it('ends the movetext with the result rather than an unfinished marker', () => {
		const pgn = composePgnFile({
			headers: gameHeadersFromTags(IMPORTED),
			startFen: DEFAULT_FEN,
			movetext: '1. d4 g6 *',
		});

		expect(pgn.trimEnd().endsWith('1-0')).toBe(true);
	});

	it('leaves the unfinished marker alone when there is no result', () => {
		const pgn = composePgnFile({
			headers: gameHeadersFromTags({ ...IMPORTED, Result: '*' }),
			startFen: DEFAULT_FEN,
			movetext: '1. d4 g6 *',
		});

		expect(pgn.trimEnd().endsWith('*')).toBe(true);
	});

	it('does not carry a stale FEN from the file it read', () => {
		const headers = gameHeadersFromTags({ ...IMPORTED, FEN: CUSTOM_FEN, SetUp: '1' });
		const tags = tagsOf(composePgnFile({ headers, startFen: DEFAULT_FEN, movetext: '*' }));

		expect(tags['FEN']).toBeUndefined();
	});
});
