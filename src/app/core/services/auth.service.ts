import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom, from, map, switchMap, tap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
	AuthResponse,
	RegisterResponse,
	ResetContext,
	SessionSummary,
	SubscriptionView,
	UserSummary,
} from '../models/user.model';
import { SessionService } from '../auth/session.service';
import { CaptchaAnswer } from '../captcha/captcha.model';
import { AnalyticsService } from '../analytics/analytics.service';
import { AnalyticsEvent } from '../analytics/analytics.events';
import { VaultService } from '../crypto/vault.service';
import { VaultMigrationService } from '../crypto/vault-migration.service';
import { DEFAULT_KDF, deriveFromPassword, parseKdf } from '../crypto/kdf';
import { VaultMaterial, VaultView } from '../crypto/vault.model';

// Passwords are split before sending: auth secret to the server, vault key never leaves.
// Only file using withCredentials: the sole path that sends, sets or clears the refresh cookie.
@Injectable({ providedIn: 'root' })
export class AuthService {
	private readonly http = inject(HttpClient);
	private readonly analytics = inject(AnalyticsService);
	private readonly session = inject(SessionService);
	private readonly vault = inject(VaultService);
	private readonly migration = inject(VaultMigrationService);
	private readonly baseUrl = `${environment.apiBaseUrl}/auth`;

	readonly currentUser = this.session.currentUser;
	readonly isLoggedIn = this.session.isLoggedIn;

	isAuthenticated(): boolean {
		return this.session.isLoggedIn();
	}

	// A recovery code is made here but not returned: it cannot survive the trip through the inbox.
	// The first sign-in replaces it with one the person is actually shown.
	register(
		username: string,
		email: string,
		password: string,
		acceptedTerms: boolean,
		captcha?: CaptchaAnswer,
	): Observable<RegisterResponse> {
		return from(this.vault.create(password, email, DEFAULT_KDF)).pipe(
			switchMap((created) =>
				this.http
					.post<RegisterResponse>(
						`${this.baseUrl}/register`,
						{
							username,
							email,
							secret: created.authSecret,
							vault: created.material,
							acceptedTerms,
							captcha,
						},
						{ withCredentials: true },
					)
					.pipe(tap(() => this.analytics.capture(AnalyticsEvent.userRegistered))),
			),
		);
	}

	// Does not sign the person in: a mailed link carries no password, so there is no key to unlock with.
	verifyEmail(token: string): Observable<void> {
		return this.http.post<void>(`${this.baseUrl}/verify-email`, { token }, { withCredentials: true });
	}

	resendVerification(email: string, captcha?: CaptchaAnswer) {
		return this.http.post<void>(`${this.baseUrl}/verify-email/resend`, { email, captcha }, { withCredentials: true });
	}

	forgotPassword(email: string, captcha?: CaptchaAnswer) {
		return this.http.post<void>(`${this.baseUrl}/forgot-password`, { email, captcha }, { withCredentials: true });
	}

	resetContext(token: string): Observable<ResetContext> {
		return this.http.get<ResetContext>(`${this.baseUrl}/reset-password/context`, {
			params: { token },
			withCredentials: true,
		});
	}

	// With a recovery code or unlocked vault the master key is re-sealed; otherwise a new key is
	// created and data sealed under the old one is deleted.
	resetPassword(token: string, newPassword: string, recoveryCode: string | null): Observable<ResetOutcome> {
		return this.resetContext(token).pipe(
			switchMap((context) => from(this.rewrapForReset(context, newPassword, recoveryCode))),
			switchMap((plan) =>
				this.http
					.post<void>(
						`${this.baseUrl}/reset-password`,
						{ token, newSecret: plan.secret, vault: plan.material, discardData: plan.discardData },
						{ withCredentials: true },
					)
					.pipe(map(() => ({ keptFiles: !plan.discardData }))),
			),
			// The reset screen has no session to hold the key, so it is dropped either way this goes.
			tap({ finalize: () => void this.vault.lock() }),
		);
	}

	verifyRecoveryCode(code: string, context: ResetContext): Promise<boolean> {
		return this.vault.verifyRecoveryCode(code, context.email, context.vault);
	}

	unlockedHere(): boolean {
		return this.vault.unlocked();
	}

	readonly pendingRecoveryCode = this.vault.pendingRecoveryCode;

	vaultSummary(): Observable<VaultView> {
		return from(this.vault.vault());
	}

	acknowledgeRecoveryCode(): Promise<void> {
		return this.vault.acknowledgeRecoveryCode();
	}

	replaceRecoveryCode(password: string): Observable<string> {
		const email = this.session.currentUser()?.email;
		if (email === undefined) {
			return throwError(() => new Error('There is no account signed in'));
		}
		return from(this.vault.replaceRecoveryCode(password, email));
	}

	login(email: string, password: string, keepSignedIn: boolean, captcha?: CaptchaAnswer): Observable<AuthResponse> {
		return from(this.signIn(email, password, keepSignedIn, captcha));
	}

	logout(): void {
		this.analytics.capture(AnalyticsEvent.userSignedOut);
		this.session.end().subscribe();
	}

	subscription() {
		return this.http.get<SubscriptionView>(`${this.baseUrl}/me/subscription`, { withCredentials: true });
	}

	changeUsername(username: string) {
		return this.http
			.patch<UserSummary>(`${this.baseUrl}/me/username`, { username }, { withCredentials: true })
			.pipe(tap((user) => this.session.setUser(user)));
	}

	// Irreversible; the server re-checks the typed username before deleting anything.
	deleteAccount(username: string) {
		return this.http.delete<void>(`${this.baseUrl}/me`, { body: { username }, withCredentials: true });
	}

	// The master key is re-sealed, not replaced, so no stored entry needs rewriting or re-uploading.
	// Ends every other session on the account, hence the new AuthResponse.
	changePassword(currentPassword: string, newPassword: string): Observable<AuthResponse> {
		const email = this.session.currentUser()?.email;
		if (email === undefined) {
			return throwError(() => new Error('There is no account signed in'));
		}

		return from(this.vault.vault()).pipe(
			switchMap((stored) =>
				from(
					Promise.all([
						deriveFromPassword(currentPassword, email, parseKdf(stored.kdf)),
						this.vault.rewrapForNewPassword(newPassword, email, stored),
					]),
				),
			),
			switchMap(([current, replacement]) =>
				this.http.post<AuthResponse>(
					`${this.baseUrl}/me/password`,
					{
						currentSecret: current.authSecret,
						newSecret: replacement.authSecret,
						vault: replacement.material,
					},
					{ withCredentials: true },
				),
			),
			tap((res) => this.signedIn(res)),
		);
	}

	sessions(): Observable<SessionSummary[]> {
		return this.http.get<SessionSummary[]>(`${this.baseUrl}/me/sessions`, { withCredentials: true });
	}

	endSession(id: number): Observable<void> {
		return this.http.delete<void>(`${this.baseUrl}/me/sessions/${id}`, { withCredentials: true });
	}

	endOtherSessions(): Observable<void> {
		return this.http.post<void>(`${this.baseUrl}/me/sessions/end-others`, {}, { withCredentials: true });
	}

	restoreSession(): Promise<void> {
		return this.session.restore();
	}

	freshAccessToken(): Promise<string | null> {
		return this.session.freshToken();
	}

	private async signIn(
		email: string,
		password: string,
		keepSignedIn: boolean,
		captcha?: CaptchaAnswer,
	): Promise<AuthResponse> {
		const prelogin = await this.vault.prelogin(email);
		const kdf = parseKdf(prelogin.kdf);

		// An account written before encryption signs in with the password itself.
		if (prelogin.protocol === 'PASSWORD') {
			return this.signInLegacy(email, password, keepSignedIn, kdf, captcha);
		}

		const derived = await deriveFromPassword(password, email, kdf);
		const response = await this.post(email, derived.authSecret, keepSignedIn, captcha);
		this.signedIn(response);

		const stored = await this.vault.vault();
		await this.vault.unlockWithDerived(derived.vaultKey, stored, response.user.id);

		try {
			await this.vault.ensureRecoveryCode(password, email);
		} catch (error) {
			console.warn('Could not prepare a recovery code for this account', error);
		}

		return response;
	}

	private async signInLegacy(
		email: string,
		password: string,
		keepSignedIn: boolean,
		kdf: ReturnType<typeof parseKdf>,
		captcha?: CaptchaAnswer,
	): Promise<AuthResponse> {
		const response = await this.post(email, password, keepSignedIn, captcha);
		this.signedIn(response);

		// The one moment this browser holds the password: creates key material and starts sealing
		// what the account already had.
		await this.migration.adopt(email, password, kdf, response.user.id);

		try {
			await this.vault.ensureRecoveryCode(password, email);
		} catch (error) {
			console.warn('Could not prepare a recovery code for this account', error);
		}
		return response;
	}

	private async post(
		email: string,
		secret: string,
		keepSignedIn: boolean,
		captcha?: CaptchaAnswer,
	): Promise<AuthResponse> {
		return firstValueFrom(
			this.http.post<AuthResponse>(
				`${this.baseUrl}/login`,
				{ email, secret, keepSignedIn, captcha },
				{ withCredentials: true },
			),
		);
	}

	// Tried in order: an already-unlocked vault in this browser, then the recovery code, then neither
	// (a new key, discarding data sealed under the old one).
	private async rewrapForReset(
		context: ResetContext,
		newPassword: string,
		recoveryCode: string | null,
	): Promise<ResetPlan> {
		const fromThisBrowser = await this.vault.rewrapFromUnlocked(newPassword, context.email, context.vault);
		if (fromThisBrowser !== null) {
			return { ...fromThisBrowser, secret: fromThisBrowser.authSecret, discardData: false };
		}

		if (recoveryCode !== null) {
			await this.vault.unlockWithRecoveryCode(recoveryCode, context.email, context.vault, null);
			const rewrapped = await this.vault.rewrapForNewPassword(newPassword, context.email, context.vault);
			return { secret: rewrapped.authSecret, material: rewrapped.material, discardData: false };
		}

		const created = await this.vault.create(newPassword, context.email, parseKdf(context.vault.kdf));
		return { secret: created.authSecret, material: created.material, discardData: true };
	}

	private signedIn(response: AuthResponse): void {
		this.session.apply(response);
		this.analytics.capture(AnalyticsEvent.userSignedIn);
	}
}

export interface ResetOutcome {
	readonly keptFiles: boolean;
}

interface ResetPlan {
	readonly secret: string;
	readonly material: VaultMaterial;
	readonly discardData: boolean;
}
