import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { TablebaseResult } from '../models/tablebase.model';

/** Largest position the Syzygy tables cover. Probes above this are refused locally. */
export const TABLEBASE_MAX_PIECES = 7;

@Injectable({ providedIn: 'root' })
export class TablebaseService {
	private readonly http = inject(HttpClient);

	probe(fen: string): Observable<TablebaseResult | null> {
		// HttpParams rather than string concatenation: a FEN contains characters that must be encoded.
		return this.http.get<TablebaseResult | null>(`${environment.apiBaseUrl}/tablebase`, {
			params: new HttpParams().set('fen', fen),
		});
	}
}
