import { Injectable } from '@angular/core';
import { AdvancedReport } from '../../../core/models/report.model';
import { OpponentScope } from '../../../core/models/search.model';

// Keyed by scope so switching tabs and back does not regenerate an unchanged report.
@Injectable()
export class AdvancedReportCache {
	private kept: { readonly key: string; readonly report: AdvancedReport } | null = null;

	get(scope: OpponentScope): AdvancedReport | null {
		return this.kept?.key === scopeKey(scope) ? this.kept.report : null;
	}

	set(scope: OpponentScope, report: AdvancedReport): void {
		this.kept = { key: scopeKey(scope), report };
	}
}

export function scopeKey(scope: OpponentScope): string {
	return `${scope.fideId}|${scope.color}|${scope.from}|${scope.to}`;
}
