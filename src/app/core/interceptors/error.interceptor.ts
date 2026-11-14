import { HttpErrorResponse, HttpEventType, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, tap, throwError } from 'rxjs';
import { ConnectivityService } from '../browser/connectivity.service';

// Exported because NotificationService matches on this text to attach a sign-in action.
export const SIGN_IN_REQUIRED = 'You need to be signed in to continue.';

export const LAST_RESORT = 'Something went wrong. Please try again.';

// Exported so a caller can tell a missing connection from a server that does not answer.
export const NO_CONNECTION = 'No internet connection. Check your connection and try again.';
const NOT_REACHED = 'PremovedPrep could not be reached. Check your connection and try again.';
const SERVER_DOWN = 'PremovedPrep cannot be reached right now. Please try again in a few minutes.';

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly problem?: Readonly<Record<string, unknown>>,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
	const connectivity = inject(ConnectivityService);
	return next(req).pipe(
		tap((event) => {
			if (event.type === HttpEventType.Response) {
				connectivity.reachedServer();
			}
		}),
		catchError((err: unknown) => {
			// The desktop app's own proxy answers 502 when it could not reach the API at all; that is the
			// same as a request that never left the machine, so it gets status 0 and the offline wording.
			const unreachable = unreachableBy(err);
			const status = unreachable !== null ? 0 : err instanceof HttpErrorResponse ? err.status : 0;
			if (unreachable === 'network' || (status === 0 && offline())) {
				connectivity.lostConnection();
			} else if (status > 0) {
				connectivity.reachedServer();
			}
			return throwError(() => new ApiError(describe(err, unreachable), status, problemOf(err)));
		}),
	);
};

type Unreachable = 'network' | 'server';

// Set by shell/local-server.js on the 502 it answers when the request to the API failed.
const UNREACHABLE_HEADER = 'X-PremovedPrep-Unreachable';

function unreachableBy(err: unknown): Unreachable | null {
	if (!(err instanceof HttpErrorResponse) || err.status !== 502) {
		return null;
	}
	const reason = err.headers?.get(UNREACHABLE_HEADER);
	return reason === 'network' || reason === 'server' ? reason : null;
}

function problemOf(err: unknown): Readonly<Record<string, unknown>> | undefined {
	if (!(err instanceof HttpErrorResponse)) {
		return undefined;
	}
	const body: unknown = err.error;
	return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
}

function describe(err: unknown, unreachable: Unreachable | null): string {
	if (!(err instanceof HttpErrorResponse)) {
		return LAST_RESORT;
	}
	if (unreachable === 'network' || (unreachable === 'server' && offline())) {
		return NO_CONNECTION;
	}
	if (unreachable === 'server') {
		return NOT_REACHED;
	}

	const detail = readDetail(err);
	if (detail) {
		return detail;
	}

	switch (err.status) {
		// Angular reports a request that never reached anything (no network, DNS, CORS) as status 0.
		case 0:
			return offline() ? NO_CONNECTION : NOT_REACHED;
		case 400:
			return 'Please check what you entered and try again.';
		case 401:
			return SIGN_IN_REQUIRED;
		case 403:
			return 'You do not have access to that.';
		case 404:
			return 'That could not be found.';
		case 408:
			return 'That took too long. Please try again.';
		case 409:
			return 'That conflicts with something already there.';
		case 413:
			return 'That file is too large.';
		case 422:
			return 'Please check what you entered and try again.';
		case 429:
			return 'Too many attempts. Please wait a moment and try again.';
		// Cloudflare's answers when it cannot reach the server behind it (520-530), and the server's
		// own proxy's when the API is not up (502, 504): nothing was wrong with the request.
		case 502:
		case 504:
			return SERVER_DOWN;
		case 503:
			return 'PremovedPrep is busy right now. Please try again in a moment.';
		case 507:
			return 'There is no room to save that right now.';
		default:
			if (err.status >= 520 && err.status <= 530) {
				return SERVER_DOWN;
			}
			if (err.status >= 500) {
				return 'PremovedPrep had a problem with that. Please try again in a moment.';
			}
			if (err.status >= 400) {
				return 'That request was refused. Please check what you entered and try again.';
			}
			return LAST_RESORT;
	}
}

// Reliable only for "offline": the browser never reports this false while a connection works.
function offline(): boolean {
	return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// Only problem+json wording written by this API; a plain-text body is never shown to the user.
function readDetail(err: HttpErrorResponse): string | null {
	const body: unknown = err.error;
	if (!body || typeof body !== 'object') {
		return null;
	}
	const detail = (body as { detail?: unknown }).detail;
	if (typeof detail !== 'string') {
		return null;
	}
	const text = detail.trim();
	return text.length > 0 && text.length < 300 ? text : null;
}
