import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AppRelease, AppStage, DesktopAppAccess } from '../models/user.model';

/** Access is decided by the server, not here: this app's source is public, so a self-check is not trustworthy. */
@Injectable({ providedIn: 'root' })
export class DesktopAppApiService {
	private readonly http = inject(HttpClient);
	private readonly baseUrl = `${environment.apiBaseUrl}/app`;

	stage(): Observable<{ stage: AppStage }> {
		return this.http.get<{ stage: AppStage }>(`${this.baseUrl}/stage`);
	}

	release(): Observable<AppRelease> {
		return this.http.get<AppRelease>(`${this.baseUrl}/release`);
	}

	access(): Observable<DesktopAppAccess> {
		return this.http.get<DesktopAppAccess>(`${this.baseUrl}/access`, { withCredentials: true });
	}
}
