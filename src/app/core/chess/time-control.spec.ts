import { describe, expect, it } from 'vitest';
import {
	FIDE_TIME_CONTROLS,
	describeTimeControl,
	parseTimeControl,
	pgnForName,
	timeControlLabel,
} from './time-control';

describe('parseTimeControl', () => {
	it.each([
		['15+10', '900+10'],
		['15 + 10', '900+10'],
		['15 min + 10 sec', '900+10'],
		[`15' + 10"`, '900+10'],
		['3+2', '180+2'],
		['90', '5400+0'],
		['90 min', '5400+0'],
		['90+30', '5400+30'],
		['90 min + 30 sec', '5400+30'],
		['90 min / 40 moves + 30 min + 30 sec', '40/5400+30:1800+30'],
		['90/40 + 30 + 30s', '40/5400+30:1800+30'],
		['90/40 + 30 + 30', '40/5400+30:1800+30'],
		['120/40 + 30', '40/7200:1800'],
		['120 min / 40 moves + 30 min + 30 sec from move 41', '40/7200:1800+30'],
		['100/40 + 50/20 + 15 + 30 sec', '40/6000+30:20/3000+30:900+30'],
		['30 sec + 1 sec', '30+1'],
		['1.5 min + 0', '90+0'],
	])('reads "%s" as %s', (text, pgn) => {
		expect(parseTimeControl(text)).toBe(pgn);
	});

	it.each(['', 'Armageddon 5 vs 4', '40/90', '3+', '+2', '30 sec from move 41', '90 min + 30 sec from move 41'])(
		'keeps "%s" as written, with no TimeControl',
		(text) => {
			expect(parseTimeControl(text)).toBeNull();
		},
	);

	it('reads every FIDE preset back to its own TimeControl', () => {
		for (const preset of FIDE_TIME_CONTROLS) {
			expect(parseTimeControl(preset.name)).toBe(preset.pgn);
			expect(describeTimeControl(preset.pgn)).toBe(preset.name);
		}
	});
});

describe('describeTimeControl', () => {
	it.each([
		['900+10', '15 min + 10 sec'],
		['1200+5', '20 min + 5 sec'],
		['600', '10 min'],
		['600+0', '10 min'],
		['30+0', '30 sec'],
		['40/6000+30:20/3000+30:900+30', '100 min / 40 moves + 50 min / 20 moves + 15 min, +30 sec'],
	])('reads %s as "%s"', (pgn, name) => {
		expect(describeTimeControl(pgn)).toBe(name);
	});

	it.each(['?', '-', 'abc', ''])('has no reading for "%s"', (pgn) => {
		expect(describeTimeControl(pgn)).toBeNull();
	});
});

describe('timeControlLabel and pgnForName', () => {
	it('prefers the game’s own name, then the reading, then the tag as written', () => {
		expect(timeControlLabel('Club night', '900+10')).toBe('Club night');
		expect(timeControlLabel(undefined, '900+10')).toBe('15 min + 10 sec');
		expect(timeControlLabel(undefined, 'abc')).toBe('abc');
		expect(timeControlLabel(undefined, undefined)).toBeNull();
	});

	it('gives a preset its own TimeControl and reads anything else', () => {
		expect(pgnForName('120 min / 40 moves + 30 min, +30 sec from move 41')).toBe('40/7200:1800+30');
		expect(pgnForName('25 min + 10 sec')).toBe('1500+10');
		expect(pgnForName('Armageddon')).toBeNull();
	});
});
