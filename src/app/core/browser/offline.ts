import { ApiError } from '../interceptors/error.interceptor';

// navigator.onLine is reliable only when false; a request that never left the machine
// surfaces as ApiError with status 0, which the error interceptor sets for that case.
export function isOffline(error?: unknown): boolean {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		return true;
	}
	return error instanceof ApiError && error.status === 0;
}

/** No answer from the server: no connection, or the server (or Cloudflare in front of it) cannot reach it. */
export function isUnreachable(error?: unknown): boolean {
	if (isOffline(error)) {
		return true;
	}
	return (
		error instanceof ApiError &&
		(error.status === 502 || error.status === 504 || (error.status >= 520 && error.status <= 530))
	);
}
