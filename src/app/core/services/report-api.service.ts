import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, forkJoin, from, map, of, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AdvancedReport, OpponentGames } from '../models/report.model';
import { OpponentScope } from '../models/search.model';
import { ItemDetail, RepertoireColor } from '../models/collection.model';
import { CollectionApiService } from './collection-api.service';
import { buildBook } from '../report/repertoire-book';
import { buildAdvancedReport } from '../report/advanced-report';
import { LocalShelfService } from '../agent/local-shelf.service';

/** Overlay against the repertoire is built here, not on the server: only here is the repertoire readable. */
@Injectable({ providedIn: 'root' })
export class ReportApiService {
	private readonly http = inject(HttpClient);
	private readonly collections = inject(CollectionApiService);
	private readonly shelf = inject(LocalShelfService);
	private readonly baseUrl = `${environment.apiBaseUrl}/report`;

	advanced(scope: OpponentScope): Observable<AdvancedReport> {
		// Our colour is the opposite of the opponent's.
		const ourColor: RepertoireColor = scope.color === 'b' ? 'w' : 'b';

		return forkJoin({
			opponent: this.opponentGames(scope),
			trunks: this.trunks(ourColor),
		}).pipe(
			map(({ opponent, trunks }) =>
				buildAdvancedReport(
					buildBook(trunks),
					opponent.games,
					opponent.fideId,
					opponent.opponentColor,
					opponent.truncated,
				),
			),
		);
	}

	private opponentGames(scope: OpponentScope): Observable<OpponentGames> {
		let params = new HttpParams().set('fideId', scope.fideId).set('color', scope.color);
		if (scope.from) {
			params = params.set('from', scope.from);
		}
		if (scope.to) {
			params = params.set('to', scope.to);
		}
		return this.http.get<OpponentGames>(`${this.baseUrl}/opponent-games`, { params });
	}

	// A local file mirroring a cloud collection is counted once, from the cloud, to avoid double-listing it.
	private trunks(color: RepertoireColor): Observable<ItemDetail[]> {
		return this.collections.list('REPERTOIRE', color).pipe(
			switchMap((collections) =>
				forkJoin({
					cloud:
						collections.length === 0
							? of([] as ItemDetail[][])
							: forkJoin(collections.map((collection) => this.collections.listDetails(collection.id))),
					local: from(this.shelf.trunks(color, new Set(collections.map((collection) => collection.id)))),
				}),
			),
			map(({ cloud, local }) => [...cloud.flat().filter((item) => item.itemType === 'MAIN_LINE'), ...local]),
		);
	}
}
