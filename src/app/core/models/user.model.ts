import { ResetVaultView } from '../crypto/vault.model';

export type SubscriptionStatus = 'FREE' | 'ACTIVE' | 'CANCELED';

export interface UserSummary {
	readonly id: number;
	readonly username: string;
	readonly email: string;
	readonly emailVerified: boolean;
	readonly subscriptionStatus: SubscriptionStatus;
	// Legacy: nothing on the server counts or enforces this.
	readonly freeReportsRemaining: number;
	readonly themePreference: 'light' | 'dark';
	readonly boardPreferences: string | null;
}

export interface RegisterResponse {
	readonly email: string;
	readonly verificationSent: boolean;
}

// The password wrap is deliberately not included here; see ResetVaultView.
export interface ResetContext {
	readonly email: string;
	readonly vault: ResetVaultView;
}

// token is the access token; the refresh token is a cookie no script can read.
export interface AuthResponse {
	readonly token: string;
	readonly expiresInSeconds: number;
	readonly user: UserSummary;
}

export interface SessionSummary {
	readonly id: number;
	readonly device: string | null;
	readonly current: boolean;
	readonly startedAt: string;
	readonly lastUsedAt: string;
}

export interface SubscriptionView {
	readonly selling: boolean;
	readonly active: boolean;
	readonly status: SubscriptionStatus;
	readonly interval: PlanInterval | null;
	// Minor units: 124 = EUR 1.24.
	readonly monthlyPriceMinor: number;
	readonly yearlyPriceMinor: number;
	readonly currency: string;
	readonly renewsAt: string | null;
	readonly canceledAt: string | null;
	readonly cancelAtPeriodEnd: boolean;
	readonly managed: boolean;
	readonly storageQuotaBytes: number;
	readonly trialAvailable: boolean;
	readonly trialEndsAt: string | null;
	// The plan is free for this account: prices are hidden rather than explained.
	readonly complimentary?: boolean;
	// A previous refund on this account: checkout needs the withdrawal waiver ticked.
	readonly waiverRequired?: boolean;
}

export type PlanInterval = 'MONTH' | 'YEAR';

export interface BillingRedirect {
	readonly url: string;
}

export type AppStage = 'PREVIEW' | 'LAUNCHED';

export interface DesktopAppAccess {
	readonly allowed: boolean;
	readonly reason: 'OK' | 'PREVIEW' | 'PLAN';
	readonly stage: AppStage;
}

export interface AppRelease {
	readonly latest: string | null;
	readonly minimum: string | null;
	readonly downloadUrl: string;
}
