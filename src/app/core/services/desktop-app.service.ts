import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AppRelease } from '../models/user.model';

@Injectable({ providedIn: 'root' })
export class DesktopAppApiService {
	private readonly http = inject(HttpClient);
	private readonly baseUrl = `${environment.apiBaseUrl}/app`;

	release(): Observable<AppRelease> {
		// Past the app's own HTTP cache: a release published a minute ago is seen at the next start,
		// not five minutes later. The server's response stays cacheable for everyone else.
		return this.http.get<AppRelease>(`${this.baseUrl}/release`, {
			headers: new HttpHeaders({ 'Cache-Control': 'no-cache' }),
		});
	}
}
