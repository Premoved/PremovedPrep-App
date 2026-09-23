import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { SKIP_SESSION_RETRY, readAccessToken } from '../auth/access-token';
import { SessionService } from '../auth/session.service';

// Runs inside errorInterceptor, so a 401 it recovers by refreshing never becomes an ApiError.
export const authInterceptor: HttpInterceptorFn = (req, next) => {
	const session = inject(SessionService);

	return next(withToken(req, readAccessToken())).pipe(
		catchError((error: unknown) => {
			const recoverable =
				error instanceof HttpErrorResponse && error.status === 401 && !req.context.get(SKIP_SESSION_RETRY);
			if (!recoverable) {
				return throwError(() => error);
			}

			// renew() shares one in-flight refresh, so concurrent 401s trigger a single call.
			return session
				.renew()
				.pipe(switchMap((token) => (token === null ? throwError(() => error) : next(withToken(req, token)))));
		}),
	);
};

function withToken(req: HttpRequest<unknown>, token: string | null): HttpRequest<unknown> {
	return token === null ? req : req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
}
