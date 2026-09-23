import { describe, expect, it } from 'vitest';
import { Annotation } from '../models/chess-enums';
import { annotationFromNag, annotationFromSan, nagFromAnnotation } from './nag-codec';

describe('nag-codec', () => {
	it('round-trips every annotation that has a NAG', () => {
		for (const annotation of Object.values(Annotation)) {
			const nag = nagFromAnnotation(annotation);
			if (!nag) continue;
			expect(annotationFromNag(nag), `NAG $${nag} for ${annotation}`).toBe(annotation);
		}
	});

	it('maps no two annotations to the same NAG', () => {
		const nags = Object.values(Annotation)
			.map(nagFromAnnotation)
			.filter((nag) => nag !== '');
		expect(new Set(nags).size).toBe(nags.length);
	});

	it('returns an empty string for annotations with no NAG equivalent', () => {
		expect(nagFromAnnotation(Annotation.EMPTY)).toBe('');
	});

	it('accepts NAGs with and without the dollar prefix', () => {
		expect(annotationFromNag('$3')).toBe(Annotation.BRILLIANT_MOVE);
		expect(annotationFromNag('3')).toBe(Annotation.BRILLIANT_MOVE);
	});

	it('returns undefined for an unknown NAG', () => {
		expect(annotationFromNag('$999')).toBeUndefined();
	});

	describe('annotationFromSan', () => {
		it('prefers two-character suffixes over one-character ones', () => {
			expect(annotationFromSan('Nf3!!')).toBe(Annotation.BRILLIANT_MOVE);
			expect(annotationFromSan('Nf3??')).toBe(Annotation.BLUNDER);
			expect(annotationFromSan('Nf3!?')).toBe(Annotation.INTERESTING_MOVE);
			expect(annotationFromSan('Nf3?!')).toBe(Annotation.DUBIOUS_MOVE);
		});

		it('reads single-character suffixes', () => {
			expect(annotationFromSan('Nf3!')).toBe(Annotation.GOOD_MOVE);
			expect(annotationFromSan('Nf3?')).toBe(Annotation.MISTAKE);
		});

		it('returns undefined for a plain SAN', () => {
			expect(annotationFromSan('Nf3')).toBeUndefined();
			expect(annotationFromSan('O-O')).toBeUndefined();
		});

		it('does not read a promotion as an evaluation', () => {
			for (const san of ['e8=Q', 'e8=R', 'e8=B', 'e8=N', 'exd8=Q+', 'a1=Q#']) {
				expect(annotationFromSan(san), san).toBeUndefined();
			}
		});

		it('still reads an evaluation attached to a promotion', () => {
			expect(annotationFromSan('e8=Q!')).toBe(Annotation.GOOD_MOVE);
			expect(annotationFromSan('e8=Q??')).toBe(Annotation.BLUNDER);
			expect(annotationFromSan('e8=N!?')).toBe(Annotation.INTERESTING_MOVE);
		});

		it('reads a bare = as equality, which is how some sources write it', () => {
			expect(annotationFromSan('Nf3=')).toBe(Annotation.EQUAL_POSITION);
		});
	});
});
