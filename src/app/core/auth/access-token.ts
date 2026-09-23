import { HttpContextToken } from '@angular/common/http';

// In-memory only, not localStorage: an XSS payload cannot read this or make it outlive the tab.
let token: string | null = null;
let expiresAtMs = 0;

export function storeAccessToken(value: string, lifetimeSeconds: number): void {
	token = value;
	expiresAtMs = Date.now() + lifetimeSeconds * 1000;
}

export function readAccessToken(): string | null {
	return token;
}

export function clearAccessToken(): void {
	token = null;
	expiresAtMs = 0;
}

// Whether the token is still worth sending. Only the server decides; this just saves a round trip.
export function accessTokenFresh(marginMs = 15_000): boolean {
	return token !== null && Date.now() < expiresAtMs - marginMs;
}

// Set on the refresh call and on logout, so neither is itself retried through a refresh.
export const SKIP_SESSION_RETRY = new HttpContextToken<boolean>(() => false);
