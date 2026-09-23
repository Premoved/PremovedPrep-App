import { Annotation } from '../models/chess-enums';

const NAG_TABLE: readonly (readonly [Annotation, string])[] = [
	[Annotation.GOOD_MOVE, '1'],
	[Annotation.MISTAKE, '2'],
	[Annotation.BRILLIANT_MOVE, '3'],
	[Annotation.BLUNDER, '4'],
	[Annotation.INTERESTING_MOVE, '5'],
	[Annotation.DUBIOUS_MOVE, '6'],
	[Annotation.ONLY_MOVE, '7'],
	[Annotation.EQUAL_POSITION, '10'],
	[Annotation.UNCLEAR_POSITION, '13'],
	[Annotation.WHITE_IS_SLIGHTLY_BETTER, '14'],
	[Annotation.BLACK_IS_SLIGHTLY_BETTER, '15'],
	[Annotation.WHITE_IS_BETTER, '16'],
	[Annotation.BLACK_IS_BETTER, '17'],
	[Annotation.WHITE_IS_WINNING, '18'],
	[Annotation.BLACK_IS_WINNING, '19'],
	[Annotation.ZUGZWANG, '22'],
	[Annotation.DEVELOPMENT, '32'],
	[Annotation.INITIATIVE, '36'],
	[Annotation.ATTACK, '40'],
	[Annotation.WITH_COMPENSATION, '44'],
	[Annotation.COUNTERPLAY, '132'],
	[Annotation.WITH_THE_IDEA, '140'],
	[Annotation.NOVELTY, '146'],
];

const NAG_BY_ANNOTATION = new Map<Annotation, string>(NAG_TABLE);
const ANNOTATION_BY_NAG = new Map<string, Annotation>(NAG_TABLE.map(([a, n]) => [n, a]));

export function nagFromAnnotation(annotation: Annotation): string {
	return NAG_BY_ANNOTATION.get(annotation) ?? '';
}

export function annotationFromNag(nag: string): Annotation | undefined {
	return ANNOTATION_BY_NAG.get(nag.replace('$', ''));
}

const PROMOTION_MARKER = /=[QRBNqrbn]/;

// Recovers an annotation from suffix characters on the SAN itself, e.g. 'Nf3!?'.
export function annotationFromSan(san: string): Annotation | undefined {
	if (san.includes('!!')) return Annotation.BRILLIANT_MOVE;
	if (san.includes('??')) return Annotation.BLUNDER;
	if (san.includes('!?')) return Annotation.INTERESTING_MOVE;
	if (san.includes('?!')) return Annotation.DUBIOUS_MOVE;
	if (san.includes('!')) return Annotation.GOOD_MOVE;
	if (san.includes('?')) return Annotation.MISTAKE;
	if (san.includes('=') && !PROMOTION_MARKER.test(san)) return Annotation.EQUAL_POSITION;
	return undefined;
}
