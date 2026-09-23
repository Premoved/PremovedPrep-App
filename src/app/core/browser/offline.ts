import { ApiError } from '../interceptors/error.interceptor';

// navigator.onLine is reliable only when false; a request that never left the machine
// surfaces as ApiError with status 0, which the error interceptor sets for that case.
export function isOffline(error?: unknown): boolean {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		return true;
	}
	return error instanceof ApiError && error.status === 0;
}
