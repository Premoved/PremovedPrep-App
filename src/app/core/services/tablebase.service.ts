import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { TablebaseResult } from '../models/tablebase.model';
import { pieceCount } from '../chess/fen.util';
import { AnalyticsService } from '../analytics/analytics.service';
import { AnalyticsEvent } from '../analytics/analytics.events';

/** Largest position the Syzygy tables cover. Probes above this are refused locally. */
export const TABLEBASE_MAX_PIECES = 7;

@Injectable({ providedIn: 'root' })
export class TablebaseService {
	private readonly http = inject(HttpClient);
	private readonly analytics = inject(AnalyticsService);

	probe(fen: string): Observable<TablebaseResult | null> {
		// Counted here because this is the one place a request actually leaves.
		this.analytics.capture(AnalyticsEvent.tablebaseProbe, { pieces: pieceCount(fen) });
		// HttpParams rather than string concatenation: a FEN contains characters that must be encoded.
		return this.http.get<TablebaseResult | null>(`${environment.apiBaseUrl}/tablebase`, {
			params: new HttpParams().set('fen', fen),
		});
	}
}
