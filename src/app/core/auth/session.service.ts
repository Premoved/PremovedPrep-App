import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, finalize, firstValueFrom, map, of, shareReplay } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthResponse, UserSummary } from '../models/user.model';
import { AnalyticsService } from '../analytics/analytics.service';
import { ThemeService } from '../services/theme.service';
import { VaultService } from '../crypto/vault.service';
import {
	SKIP_SESSION_RETRY,
	accessTokenFresh,
	clearAccessToken,
	readAccessToken,
	storeAccessToken,
} from './access-token';

@Injectable({ providedIn: 'root' })
export class SessionService {
	private readonly http = inject(HttpClient);
	private readonly analytics = inject(AnalyticsService);
	private readonly theme = inject(ThemeService);
	private readonly vault = inject(VaultService);
	private readonly baseUrl = `${environment.apiBaseUrl}/auth`;

	private readonly _currentUser = signal<UserSummary | null>(null);
	readonly currentUser = this._currentUser.asReadonly();
	readonly isLoggedIn = computed(() => this._currentUser() !== null);

	private renewal: Observable<string | null> | null = null;
	private ahead: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		// Cross-tab sync: only a "something changed" flag crosses via storage, never the token itself.
		window.addEventListener('storage', (event) => {
			if (event.key !== SIGNAL_KEY) {
				return;
			}
			const changed = state(event.newValue);
			if (changed === 'out') {
				this.forget();
			} else if (changed === 'in' && !this.isLoggedIn()) {
				this.renew().subscribe();
			}
		});

		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible' && this.isLoggedIn() && !accessTokenFresh()) {
				this.renew().subscribe();
			}
		});
	}

	async restore(): Promise<void> {
		await firstValueFrom(this.renew());
		await this.restoreVault();
	}

	private async restoreVault(): Promise<void> {
		const user = this._currentUser();
		if (user === null) {
			return;
		}

		try {
			if (await this.vault.restore(user.id, await this.vault.vault())) {
				return;
			}
		} catch {
			// Storage unavailable: treated as no stored session.
		}

		// No key for this account: sign out locally rather than show a session that can decrypt nothing.
		this.forget();
	}

	apply(response: AuthResponse): void {
		storeAccessToken(response.token, response.expiresInSeconds);
		this._currentUser.set(response.user);
		this.analytics.identify(response.user.id);
		announce('in');
		this.scheduleRenewal(response.expiresInSeconds * 1000);
	}

	renew(): Observable<string | null> {
		if (this.renewal === null) {
			this.renewal = this.http
				.post<AuthResponse>(`${this.baseUrl}/refresh`, {}, { withCredentials: true, context: skip() })
				.pipe(
					map((response) => {
						this.apply(response);
						return response.token;
					}),
					catchError((error: unknown) => {
						// 401 means refused (no session); any other error is treated as transient and retried.
						if (error instanceof HttpErrorResponse && error.status === 401) {
							this.forget();
						} else {
							this.scheduleIn(RETRY_MS);
						}
						return of(null);
					}),
					finalize(() => {
						this.renewal = null;
					}),
					shareReplay({ bufferSize: 1, refCount: false }),
				);
		}
		return this.renewal;
	}

	end(): Observable<void> {
		const request = this.http
			.post<void>(`${this.baseUrl}/logout`, {}, { withCredentials: true, context: skip() })
			.pipe(catchError(() => of(undefined as void)));

		this.forget();
		announce('out');
		return request;
	}

	async freshToken(): Promise<string | null> {
		if (accessTokenFresh(60_000)) {
			return readAccessToken();
		}
		return firstValueFrom(this.renew());
	}

	forget(): void {
		const wasSignedIn = this._currentUser() !== null;

		clearAccessToken();

		// Key must be gone before the logout network call even starts, and regardless of its outcome.
		void this.vault.lock();
		this._currentUser.set(null);
		this.cancelRenewal();
		this.analytics.reset();

		if (wasSignedIn) {
			this.theme.reset();
		}
	}

	setUser(user: UserSummary): void {
		this._currentUser.set(user);
	}

	private scheduleRenewal(lifetimeMs: number): void {
		this.scheduleIn(Math.max(10_000, lifetimeMs - 60_000));
	}

	private scheduleIn(delayMs: number): void {
		this.cancelRenewal();
		this.ahead = setTimeout(() => this.renew().subscribe(), delayMs);
	}

	private cancelRenewal(): void {
		if (this.ahead !== null) {
			clearTimeout(this.ahead);
			this.ahead = null;
		}
	}
}

const SIGNAL_KEY = 'premovedprep.session';
const RETRY_MS = 60_000;

function announce(what: 'in' | 'out'): void {
	try {
		// Timestamp makes the value change every call; an unchanged value fires no storage event.
		localStorage.setItem(SIGNAL_KEY, `${what}:${Date.now()}`);
	} catch {
		// Storage unavailable: other tabs are not notified.
	}
}

function state(value: string | null): string {
	return (value ?? '').split(':')[0];
}

function skip(): HttpContext {
	return new HttpContext().set(SKIP_SESSION_RETRY, true);
}
