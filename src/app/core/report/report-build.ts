import { AdvancedReport, ArchiveGame } from '../models/report.model';
import { ItemDetail } from '../models/collection.model';
import { BookCollection, buildBook } from './repertoire-book';
import { buildAdvancedReport } from './advanced-report';

/** Everything a report is built from; structured-cloneable, so it can be handed to a worker. */
export interface ReportInput {
	readonly trunks: readonly ItemDetail[];
	readonly collections: ReadonlyMap<number, BookCollection>;
	readonly localEntries: ReadonlyMap<number, string>;
	readonly games: readonly ArchiveGame[];
	readonly fideId: number;
	readonly opponentColor: 'w' | 'b';
	readonly truncated: boolean;
}

export type ReportAnswer =
	{ readonly ok: true; readonly report: AdvancedReport } | { readonly ok: false; readonly message: string };

export function buildReport(input: ReportInput): AdvancedReport {
	return buildAdvancedReport(
		buildBook(input.trunks, input.collections, input.localEntries),
		input.games,
		input.fideId,
		input.opponentColor,
		input.truncated,
	);
}
