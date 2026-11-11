import { ResetVaultView } from '../crypto/vault.model';
import { ThemeName } from '../theme/themes';

export interface UserSummary {
	readonly id: number;
	readonly username: string;
	readonly email: string;
	readonly emailVerified: boolean;
	readonly themePreference: ThemeName;
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

export interface AppRelease {
	readonly latest: string | null;
	readonly minimum: string | null;
	readonly downloadUrl: string;
}
