import { Injectable, inject } from '@angular/core';
import { Observable, catchError, shareReplay, throwError } from 'rxjs';
import { AdvancedReport } from '../../../core/models/report.model';
import { OpponentScope } from '../../../core/models/search.model';
import { ReportApiService } from '../../../core/services/report-api.service';

// One report per page, keyed by scope: started in the background when a search runs, joined by
// the Advanced report panel when it opens, and kept while the panels are switched.
@Injectable()
export class AdvancedReportCache {
	private readonly api = inject(ReportApiService);

	private kept: { readonly key: string; readonly report: Observable<AdvancedReport> } | null = null;

	/** The report for this scope: the one already built or being built, or a new build. */
	load(scope: OpponentScope): Observable<AdvancedReport> {
		const key = scopeKey(scope);
		if (this.kept?.key === key) {
			return this.kept.report;
		}

		const report = this.api.advanced(scope).pipe(
			// A failure is not kept, so opening the panel tries again.
			catchError((error: unknown) => {
				if (this.kept?.key === key) {
					this.kept = null;
				}
				return throwError(() => error);
			}),
			shareReplay({ bufferSize: 1, refCount: false }),
		);
		this.kept = { key, report };
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
