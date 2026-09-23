export type AuthProtocol = 'PASSWORD' | 'SECRET';

// What GET /api/auth/prelogin answers: how to turn the typed password into what /login expects.
export interface Prelogin {
	readonly protocol: AuthProtocol;
	/** The KDF descriptor, as stored. Parsed by parseKdf; never trusted to be anything in particular. */
	readonly kdf: string;
}

export interface VaultMaterial {
	readonly keyId: string;
	readonly kdf: string;
	readonly passwordWrap: string;
	readonly recoveryWrap: string;
}

export interface VaultView extends VaultMaterial {
	readonly createdAt: string | null;
	readonly updatedAt: string | null;
	readonly acknowledgedAt: string | null;
}

// The password wrap is deliberately absent: a reset link opens the recovery wrap or makes a new
// key, never the password wrap, so sending it would give a link holder something to attack offline.
export interface ResetVaultView {
	readonly keyId: string;
	readonly kdf: string;
	readonly recoveryWrap: string;
}

export type RecoverableVault = Pick<ResetVaultView, 'keyId' | 'kdf' | 'recoveryWrap'>;

export type UnlockableVault = Pick<VaultMaterial, 'keyId' | 'passwordWrap'>;

// Exists as a return type so the recovery code cannot be quietly dropped: whoever calls
// VaultService.create must decide what to do with it, and the only correct answer is to show it.
export interface NewVault {
	readonly material: VaultMaterial;
	readonly authSecret: string;
	readonly recoveryCode: string;
}
