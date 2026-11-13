import { Injectable, inject } from '@angular/core';
import { Observable, Subject, catchError, shareReplay, takeUntil, tap, throwError } from 'rxjs';
import { AdvancedReport } from '../../../core/models/report.model';
import { OpponentScope } from '../../../core/models/search.model';
import { ReportApiService } from '../../../core/services/report-api.service';
import { AgentSelectionStore } from '../../../core/agent/agent-selection.store';
import { queryChannel } from '../../../core/agent/agent-bridge.service';

// Enough for both colours of the last few players; a report is a small tree.
const KEPT_REPORTS = 6;

// The reports of one page, keyed by scope: started in the background when a search runs, joined by
// the Advanced report panel when it opens, and kept while the panels and the colour are switched.
// One is built at a time: asking for another gives up the one still being built.
@Injectable()
export class AdvancedReportCache {
	private readonly api = inject(ReportApiService);
	private readonly selection = inject(AgentSelectionStore);

	private readonly kept = new Map<string, Observable<AdvancedReport>>();

	private building: { readonly key: string; readonly giveUp: Subject<void> } | null = null;

	// Local games still being read for the report given up are dropped through this channel.
	private readonly channel = queryChannel('advanced-report');

	/** The report for this scope: the one already built or being built, or a new build. */
	load(scope: OpponentScope): Observable<AdvancedReport> {
		// Another database is another report.
		const key = `${scopeKey(scope)}|${this.selection.database()?.id ?? 'archive'}`;
		const held = this.kept.get(key);
		if (held) {
			return held;
		}

		if (this.building) {
			// Unsubscribes from the build: its request is aborted and its worker stopped.
			this.kept.delete(this.building.key);
			this.building.giveUp.next();
		}

		const giveUp = new Subject<void>();
		const settled = (): void => {
			if (this.building?.giveUp === giveUp) {
				this.building = null;
			}
		};
		const report: Observable<AdvancedReport> = this.api.advanced(scope, this.channel).pipe(
			takeUntil(giveUp),
			tap({ next: settled }),
			// A failure is not kept, so opening the panel tries again.
			catchError((error: unknown) => {
				settled();
				if (this.kept.get(key) === report) {
					this.kept.delete(key);
				}
				return throwError(() => error);
			}),
			shareReplay({ bufferSize: 1, refCount: false }),
		);
		this.building = { key, giveUp };
		this.kept.set(key, report);
		for (const oldest of this.kept.keys()) {
			if (this.kept.size <= KEPT_REPORTS) {
				break;
			}
			this.kept.delete(oldest);
		}
		return report;
	}

	/** Starts the build without waiting for it; an error waits for the panel to report it. */
	prefetch(scope: OpponentScope): void {
		this.load(scope).subscribe({ error: () => undefined });
	}
}

export function scopeKey(scope: OpponentScope): string {
	return `${scope.fideId}|${scope.color}|${scope.from}|${scope.to}`;
}
