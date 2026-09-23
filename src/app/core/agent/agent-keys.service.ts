import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AgentKeySummary, NewAgentKey } from './agent.models';

/** Agent key management on this site's API, not on the agent itself. */
@Injectable({ providedIn: 'root' })
export class AgentKeysService {
	private readonly http = inject(HttpClient);

	list(): Observable<AgentKeySummary[]> {
		return this.http.get<AgentKeySummary[]>(`${environment.apiBaseUrl}/agent/keys`);
	}

	create(label: string): Observable<NewAgentKey> {
		return this.http.post<NewAgentKey>(`${environment.apiBaseUrl}/agent/keys`, { label });
	}

	revoke(id: number): Observable<void> {
		return this.http.delete<void>(`${environment.apiBaseUrl}/agent/keys/${id}`);
	}
}
