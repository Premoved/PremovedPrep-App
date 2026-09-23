import { Annotation } from '../models/chess-enums';

export interface AnnotationOption {
	readonly value: Annotation;
	readonly label: string;
}

// Display order; each value is also the glyph rendered.
export const ANNOTATION_OPTIONS: readonly AnnotationOption[] = [
	{ value: Annotation.EMPTY, label: 'Clear annotation' },
	{ value: Annotation.EQUAL_POSITION, label: 'Equal position' },
	{ value: Annotation.ONLY_MOVE, label: 'Only move' },
	{ value: Annotation.ZUGZWANG, label: 'Zugzwang' },
	{ value: Annotation.WITH_THE_IDEA, label: 'With the idea' },
	{ value: Annotation.UNCLEAR_POSITION, label: 'Unclear position' },

	{ value: Annotation.GOOD_MOVE, label: 'Good move' },
	{ value: Annotation.MISTAKE, label: 'Mistake' },
	{ value: Annotation.BRILLIANT_MOVE, label: 'Brilliant move' },
	{ value: Annotation.BLUNDER, label: 'Blunder' },
	{ value: Annotation.INTERESTING_MOVE, label: 'Interesting move' },
	{ value: Annotation.DUBIOUS_MOVE, label: 'Dubious move' },

	{ value: Annotation.WHITE_IS_SLIGHTLY_BETTER, label: 'White is slightly better' },
	{ value: Annotation.BLACK_IS_SLIGHTLY_BETTER, label: 'Black is slightly better' },
	{ value: Annotation.WHITE_IS_BETTER, label: 'White is better' },
	{ value: Annotation.BLACK_IS_BETTER, label: 'Black is better' },
	{ value: Annotation.WHITE_IS_WINNING, label: 'White is winning' },
	{ value: Annotation.BLACK_IS_WINNING, label: 'Black is winning' },

	{ value: Annotation.NOVELTY, label: 'Theoretical novelty' },
	{ value: Annotation.DEVELOPMENT, label: 'Lead in development' },
	{ value: Annotation.INITIATIVE, label: 'With initiative' },
	{ value: Annotation.ATTACK, label: 'With attack' },
	{ value: Annotation.COUNTERPLAY, label: 'With counterplay' },
	{ value: Annotation.WITH_COMPENSATION, label: 'With compensation' },
];
