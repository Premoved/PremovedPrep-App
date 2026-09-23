import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, from } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AgentBridgeService } from '../agent/agent-bridge.service';
import { AgentSelectionStore } from '../agent/agent-selection.store';
import { GameDetail, GamePage, GameSortKey } from '../models/game-list.model';
import { OpeningTree } from '../models/opening-tree.model';

const PAGE_SIZE = 100;

@Injectable({ providedIn: 'root' })
export class OpeningExplorerService {
	private readonly http = inject(HttpClient);
	private readonly bridge = inject(AgentBridgeService);
	private readonly selection = inject(AgentSelectionStore);

	openingTree(fen: string): Observable<OpeningTree> {
		const local = this.selection.database();
		if (local) {
			return from(this.bridge.request<OpeningTree>('db.tree', { databaseId: local.id, fen }));
		}

		// HttpParams rather than string concatenation: a FEN contains characters that must be encoded.
		return this.http.get<OpeningTree>(`${environment.apiBaseUrl}/opening-tree`, {
			params: new HttpParams().set('fen', fen),
		});
	}

	gamesAtPosition(fen: string, sort: GameSortKey, ascending: boolean, page: number): Observable<GamePage> {
		const local = this.selection.database();
		if (local) {
			return from(
				this.bridge.request<GamePage>('db.games', {
					databaseId: local.id,
					fen,
					sort,
					ascending,
					page,
					size: PAGE_SIZE,
				}),
			);
		}

		return this.http.get<GamePage>(`${environment.apiBaseUrl}/games/at-position`, {
			params: new HttpParams()
				.set('fen', fen)
				.set('sort', sort)
				.set('ascending', ascending)
				.set('page', page)
				.set('size', PAGE_SIZE),
		});
	}

	game(id: number): Observable<GameDetail> {
		const local = this.selection.database();
		if (local) {
			return from(this.bridge.request<GameDetail>('db.game', { databaseId: local.id, gameId: id }));
		}

		return this.http.get<GameDetail>(`${environment.apiBaseUrl}/games/${id}`);
	}
}
