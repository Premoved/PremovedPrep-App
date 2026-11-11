import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, forkJoin, from, map, of, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AdvancedReport, OpponentGames } from '../models/report.model';
import { OpponentScope } from '../models/search.model';
import { CollectionSummary, ItemDetail, RepertoireColor } from '../models/collection.model';
import { CollectionApiService } from './collection-api.service';
import { BookCollection, buildBook } from '../report/repertoire-book';
import { buildAdvancedReport } from '../report/advanced-report';
import { LocalShelfService } from '../agent/local-shelf.service';
import { AgentBridgeService } from '../agent/agent-bridge.service';
import { AgentSelectionStore, NO_DATABASE } from '../agent/agent-selection.store';
import { AuthService } from './auth.service';
import { SearchApiService } from './search-api.service';

/** Overlay against the repertoire is built here, not on the server: only here is the repertoire readable. */
@Injectable({ providedIn: 'root' })
export class ReportApiService {
	private readonly http = inject(HttpClient);
	private readonly collections = inject(CollectionApiService);
	private readonly shelf = inject(LocalShelfService);
	private readonly bridge = inject(AgentBridgeService);
	private readonly selection = inject(AgentSelectionStore);
	private readonly search = inject(SearchApiService);
	private readonly auth = inject(AuthService);
	private readonly baseUrl = `${environment.apiBaseUrl}/report`;

	advanced(scope: OpponentScope): Observable<AdvancedReport> {
		// Our colour is the opposite of the opponent's.
		const ourColor: RepertoireColor = scope.color === 'b' ? 'w' : 'b';

		return forkJoin({
			opponent: this.opponentGames(scope),
			repertoire: this.trunks(ourColor),
		}).pipe(
			map(({ opponent, repertoire }) =>
				buildAdvancedReport(
					buildBook(repertoire.trunks, repertoire.collections, repertoire.localEntries),
					opponent.games,
					opponent.fideId,
					opponent.opponentColor,
					opponent.truncated,
				),
			),
		);
	}

	// From the database selected in the app, like the games list and the opening tree beside it; the
	// archive on the server only when none is selected.
	private opponentGames(scope: OpponentScope): Observable<OpponentGames> {
		const local = this.selection.database();
		if (local) {
			return from(
				this.search.nameKeys(scope.fideId).then((nameKeys) =>
					this.bridge
						.request<OpponentGames>('db.opponentGames', {
							databaseId: local.id,
							nameKeys,
							color: scope.color,
							from: scope.from ?? undefined,
							to: scope.to ?? undefined,
						})
						.then((games) => ({ ...games, fideId: scope.fideId })),
				),
			);
		}

		if (this.selection.noDatabase()) {
			return throwError(() => new Error(NO_DATABASE));
		}

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
	// The collections' names and icons come along, for the cards that link back to these main lines.
	private trunks(color: RepertoireColor): Observable<{
		trunks: ItemDetail[];
		collections: Map<number, BookCollection>;
		localEntries: Map<number, string>;
	}> {
		// Signed out, the repertoire is only the files on this computer.
		const cloudShelf: Observable<CollectionSummary[]> = this.auth.isLoggedIn()
			? this.collections.list('REPERTOIRE', color)
			: of([]);
		return cloudShelf.pipe(
			switchMap((collections) =>
				forkJoin({
					cloud:
						collections.length === 0
							? of([] as ItemDetail[][])
							: forkJoin(collections.map((collection) => this.collections.listDetails(collection.id))),
					local: from(this.shelf.trunks(color, new Set(collections.map((collection) => collection.id)))),
				}).pipe(
					map(({ cloud, local }) => ({
						trunks: [...cloud.flat().filter((item) => item.itemType === 'MAIN_LINE'), ...local.trunks],
						collections: new Map<number, BookCollection>([
							...collections.map(
								(collection) => [collection.id, { name: collection.name, icon: collection.icon }] as const,
							),
							...local.collections,
						]),
						localEntries: local.entries,
					})),
				),
			),
		);
	}
}
