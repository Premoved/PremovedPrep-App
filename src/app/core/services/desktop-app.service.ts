import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AppRelease } from '../models/user.model';

@Injectable({ providedIn: 'root' })
export class DesktopAppApiService {
	private readonly http = inject(HttpClient);
	private readonly baseUrl = `${environment.apiBaseUrl}/app`;

	release(): Observable<AppRelease> {
		return this.http.get<AppRelease>(`${this.baseUrl}/release`);
	}
}
