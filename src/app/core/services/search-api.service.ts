import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
// from is aliased because opponentGames takes a parameter of the same name.
import { Observable, from as observableFrom, firstValueFrom } from 'rxjs';
import { AgentBridgeService } from '../agent/agent-bridge.service';
import { AgentSelectionStore } from '../agent/agent-selection.store';
import { environment } from '../../../environments/environment';
import { OpeningTree } from '../models/opening-tree.model';
import {
	AdvancedCriteria,
	OpponentScope,
	PlayerProfile,
	PlayerSuggestion,
	SearchColor,
	SearchResultPage,
	SearchSortKey,
} from '../models/search.model';

const PAGE_SIZE = 100;

export const RECENT_PREVIEW_SIZE = 30;

@Injectable({ providedIn: 'root' })
export class SearchApiService {
	private readonly http = inject(HttpClient);
	private readonly bridge = inject(AgentBridgeService);
	private readonly selection = inject(AgentSelectionStore);
	private readonly baseUrl = `${environment.apiBaseUrl}/search`;

	suggestPlayers(query: string, limit = 12): Observable<PlayerSuggestion[]> {
		return this.http.get<PlayerSuggestion[]>(`${environment.apiBaseUrl}/players/search`, {
			params: new HttpParams().set('q', query).set('limit', limit),
		});
	}

	suggestArchivePlayers(query: string, limit = 12): Observable<PlayerSuggestion[]> {
		const local = this.selection.database();
		if (!local) {
			return this.suggestPlayers(query, limit);
		}
		return observableFrom(
			this.bridge
				.request<LocalPlayerSuggestion[]>('db.players', { databaseId: local.id, q: query, limit })
				.then<PlayerSuggestion[]>((rows) =>
					rows.map((row) => ({
						// 0 is the agreed 'not a FIDE player' id for a name taken from a PGN.
						fideId: 0,
						name: row.name,
						federation: null,
						title: null,
						standardRating: row.topElo,
					})),
				),
		);
	}

	playerProfile(fideId: number): Observable<PlayerProfile> {
		return this.http.get<PlayerProfile>(`${this.baseUrl}/player/${fideId}`);
	}

	private readonly identities = new Map<number, Promise<PlayerIdentity>>();

	private identity(fideId: number): Promise<PlayerIdentity> {
		let cached = this.identities.get(fideId);
		if (!cached) {
			cached = firstValueFrom(this.http.get<PlayerIdentity>(`${this.baseUrl}/player/${fideId}/identity`)).catch(
				() => ({ keys: [], spellings: [] }) as PlayerIdentity,
			);
			this.identities.set(fideId, cached);
		}
		return cached;
	}

	opponentGames(
		fideId: number,
		color: SearchColor,
		from: string | null,
		to: string | null,
		sort: SearchSortKey,
		ascending: boolean,
		page: number,
	): Observable<SearchResultPage> {
		const local = this.selection.database();
		if (local) {
			return observableFrom(
				this.identity(fideId).then((identity) =>
					this.bridge.request<SearchResultPage>('db.opponent', {
						databaseId: local.id,
						nameKeys: identity.keys,
						color,
						from: from ?? undefined,
						to: to ?? undefined,
						sort,
						ascending,
						page,
						size: PAGE_SIZE,
					}),
				),
			);
		}

		let params = new HttpParams()
			.set('fideId', fideId)
			.set('color', color)
			.set('sort', sort)
			.set('ascending', ascending)
			.set('page', page)
			.set('size', PAGE_SIZE);
		params = withOptional(params, 'from', from);
		params = withOptional(params, 'to', to);

		return this.http.get<SearchResultPage>(`${this.baseUrl}/opponent`, { params });
	}

	opponentOpeningTree(scope: OpponentScope, fen: string): Observable<OpeningTree> {
		const local = this.selection.database();
		if (local) {
			return observableFrom(
				this.identity(scope.fideId).then((identity) =>
					this.bridge.request<OpeningTree>('db.opponentTree', {
						databaseId: local.id,
						nameKeys: identity.keys,
						color: scope.color,
						from: scope.from ?? undefined,
						to: scope.to ?? undefined,
						fen,
					}),
				),
			);
		}

		let params = new HttpParams().set('fideId', scope.fideId).set('color', scope.color).set('fen', fen);
		params = withOptional(params, 'from', scope.from);
		params = withOptional(params, 'to', scope.to);

		return this.http.get<OpeningTree>(`${this.baseUrl}/opponent/opening-tree`, { params });
	}

	recent(sort: SearchSortKey, ascending: boolean, size = RECENT_PREVIEW_SIZE): Observable<SearchResultPage> {
		const local = this.selection.database();
		if (local) {
			return observableFrom(
				this.bridge.request<SearchResultPage>('db.search', {
					databaseId: local.id,
					results: [],
					sort,
					ascending,
					page: 0,
					size,
				}),
			);
		}

		const params = new HttpParams().set('sort', sort).set('ascending', ascending).set('size', size);
		return this.http.get<SearchResultPage>(`${this.baseUrl}/recent`, { params });
	}

	advanced(
		criteria: AdvancedCriteria,
		sort: SearchSortKey,
		ascending: boolean,
		page: number,
	): Observable<SearchResultPage> {
		const local = this.selection.database();
		if (local) {
			return observableFrom(
				this.bridge.request<SearchResultPage>('db.search', {
					databaseId: local.id,
					white: blankToUndefined(criteria.white),
					black: blankToUndefined(criteria.black),
					ignoreColours: criteria.ignoreColours,
					whiteEloMin: numberOrUndefined(criteria.whiteEloMin),
					whiteEloMax: numberOrUndefined(criteria.whiteEloMax),
					blackEloMin: numberOrUndefined(criteria.blackEloMin),
					blackEloMax: numberOrUndefined(criteria.blackEloMax),
					from: blankToUndefined(criteria.from),
					to: blankToUndefined(criteria.to),
					event: blankToUndefined(criteria.event),
					eco: blankToUndefined(criteria.eco),
					results: criteria.results,
					sort,
					ascending,
					page,
					size: PAGE_SIZE,
				}),
			);
		}

		let params = new HttpParams()
			.set('sort', sort)
			.set('ascending', ascending)
			.set('page', page)
			.set('size', PAGE_SIZE);

		params = withOptional(params, 'white', criteria.white);
		params = withOptional(params, 'black', criteria.black);
		if (criteria.ignoreColours) {
			params = params.set('ignoreColours', true);
		}
		params = withOptional(params, 'whiteEloMin', criteria.whiteEloMin);
		params = withOptional(params, 'whiteEloMax', criteria.whiteEloMax);
		params = withOptional(params, 'blackEloMin', criteria.blackEloMin);
		params = withOptional(params, 'blackEloMax', criteria.blackEloMax);
		params = withOptional(params, 'from', criteria.from);
		params = withOptional(params, 'to', criteria.to);
		params = withOptional(params, 'event', criteria.event);
		params = withOptional(params, 'eco', criteria.eco);
		// Repeatable parameters rather than comma-joined, which is what Spring reads back into a list.
		for (const token of criteria.results) {
			params = params.append('results', token);
		}

		return this.http.get<SearchResultPage>(`${this.baseUrl}/advanced`, { params });
	}
}

function withOptional(params: HttpParams, key: string, value: string | null | undefined): HttpParams {
	const trimmed = value?.trim();
	return trimmed ? params.set(key, trimmed) : params;
}

function blankToUndefined(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function numberOrUndefined(value: string | null | undefined): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

interface PlayerIdentity {
	readonly keys: readonly string[];
	readonly spellings: readonly string[];
}

interface LocalPlayerSuggestion {
	readonly name: string;
	readonly games: number;
	readonly topElo: number | null;
}
