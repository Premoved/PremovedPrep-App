import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface UserTimeControl {
	readonly id: number;
	readonly value: string;
	readonly createdAt: string;
}

// The account's saved presets, on top of the five built in for everyone.
@Injectable({ providedIn: 'root' })
export class TimeControlApiService {
	private readonly http = inject(HttpClient);
	private readonly baseUrl = `${environment.apiBaseUrl}/me/time-controls`;

	list(): Observable<UserTimeControl[]> {
		return this.http.get<UserTimeControl[]>(this.baseUrl);
	}

	create(value: string): Observable<void> {
		return this.http.post<void>(this.baseUrl, { value });
	}

	remove(id: number): Observable<void> {
		return this.http.delete<void>(`${this.baseUrl}/${id}`);
	}
}
