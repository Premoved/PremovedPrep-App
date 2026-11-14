import { Injectable, signal } from '@angular/core';
import { environment } from '../../../environments/environment';

// While offline, how often the server is asked whether the connection is back.
const RETRY_MS = 30_000;

/**
 * Whether this machine can reach the internet, as the requests themselves find it: navigator.onLine
 * stays true on a network without internet. The error interceptor reports what each request met;
 * while offline, a light request every half minute notices the connection coming back.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
	private readonly _offline = signal(typeof navigator !== 'undefined' && navigator.onLine === false);
	readonly offline = this._offline.asReadonly();

	private retry: ReturnType<typeof setInterval> | null = null;

	constructor() {
		if (typeof window === 'undefined') {
			return;
		}
		window.addEventListener('offline', () => this.lostConnection());
		window.addEventListener('online', () => void this.check());
		if (this._offline()) {
			this.watch();
		}
	}

	/** A request got an answer from the server, whatever the answer. */
	reachedServer(): void {
		if (this._offline()) {
			this._offline.set(false);
		}
		if (this.retry !== null) {
			clearInterval(this.retry);
			this.retry = null;
		}
	}

	/** A request could not leave this machine. */
	lostConnection(): void {
		this._offline.set(true);
		this.watch();
	}

	private watch(): void {
		if (this.retry === null) {
			this.retry = setInterval(() => void this.check(), RETRY_MS);
		}
	}

	// fetch, not HttpClient: the interceptor reports to this service, and this must not report to itself.
	private async check(): Promise<void> {
		try {
			const response = await fetch(`${environment.apiBaseUrl}/app/stage`, { cache: 'no-store' });
			// The desktop app's proxy marks a request it could not send at all (shell/local-server.js).
			if (response.status === 502 && response.headers.get('X-PremovedPrep-Unreachable') === 'network') {
				this.lostConnection();
				return;
			}
			this.reachedServer();
		} catch {
			this.lostConnection();
		}
	}
}
