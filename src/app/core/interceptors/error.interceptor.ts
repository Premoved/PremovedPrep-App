import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

// Exported because NotificationService matches on this text to attach a sign-in action.
export const SIGN_IN_REQUIRED = 'You need to be signed in to continue.';

export const LAST_RESORT = 'Something went wrong. Please try again.';

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

export const errorInterceptor: HttpInterceptorFn = (req, next) =>
	next(req).pipe(
		catchError((err: unknown) =>
			throwError(() => new ApiError(describe(err), err instanceof HttpErrorResponse ? err.status : 0, problemOf(err))),
		),
	);

function problemOf(err: unknown): Readonly<Record<string, unknown>> | undefined {
	if (!(err instanceof HttpErrorResponse)) {
		return undefined;
	}
	const body: unknown = err.error;
	return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
}

function describe(err: unknown): string {
	if (!(err instanceof HttpErrorResponse)) {
		return LAST_RESORT;
	}

	const detail = readDetail(err);
	if (detail) {
		return detail;
	}

	switch (err.status) {
		// Angular reports a request that never reached anything (no network, DNS, CORS) as status 0.
		case 0:
			return offline()
				? 'No internet connection. Check your connection and try again.'
				: 'PremovedPrep could not be reached. Check your connection and try again.';
		case 400:
			return 'Please check what you entered and try again.';
		case 401:
			return SIGN_IN_REQUIRED;
		case 402:
			return 'That is part of a paid plan.';
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
		case 503:
			return 'PremovedPrep is busy right now. Please try again in a moment.';
		case 507:
			return 'There is no room to save that right now.';
		default:
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
