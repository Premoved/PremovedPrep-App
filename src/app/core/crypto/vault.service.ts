import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Bytes, fromBase64Url, randomBytes, toBase64Url } from './base64url';
import { EnvelopePurpose, open, seal } from './envelope';
import { DEFAULT_KDF, KdfParameters, describeKdf, deriveFromPassword, deriveFromRecoveryCode, parseKdf } from './kdf';
import { newRecoveryCode, readRecoveryCode } from './recovery-code';
import { NewVault, Prelogin, RecoverableVault, UnlockableVault, VaultMaterial, VaultView } from './vault.model';
import { forgetKey, recallKey, rememberKey } from './vault-storage';

// Password -> PBKDF2+HKDF -> vaultKey wraps the master key, which seals every document.
// Signed in but locked (new device, cleared profile) is a valid state, not empty data.
@Injectable({ providedIn: 'root' })
export class VaultService {
	private readonly http = inject(HttpClient);
	private readonly baseUrl = `${environment.apiBaseUrl}`;

	private readonly _keyId = signal<string | null>(null);
	private masterKey: CryptoKey | null = null;

	private readonly _pendingRecoveryCode = signal<string | null>(null);

	readonly pendingRecoveryCode = this._pendingRecoveryCode.asReadonly();

	readonly unlocked = computed(() => this._keyId() !== null);

	readonly keyId = this._keyId.asReadonly();

	async seal(purpose: EnvelopePurpose, plaintext: string): Promise<string> {
		const { key, keyId } = this.require();
		return seal(key, keyId, purpose, plaintext);
	}

	async open(purpose: EnvelopePurpose, envelope: string): Promise<string> {
		const { key, keyId } = this.require();
		return open(key, keyId, purpose, envelope);
	}

	// Refused, not queued: a caller reaching here while locked drew a screen it should not have, and
	// blocking on an unlock that may never come would turn that bug into a hang.
	private require(): { key: CryptoKey; keyId: string } {
		const keyId = this._keyId();
		if (this.masterKey === null || keyId === null) {
			throw new VaultLockedError();
		}
		return { key: this.masterKey, keyId };
	}

	prelogin(email: string): Promise<Prelogin> {
		return firstValueFrom(
			this.http.get<Prelogin>(`${this.baseUrl}/auth/prelogin`, { params: { email }, withCredentials: true }),
		);
	}

	// Creates and returns material but unlocks nothing and stores nothing: the caller registers the
	// account with the result and then signs in like anyone else, on the same path every sign-in uses.
	async create(password: string, email: string, kdf: KdfParameters = DEFAULT_KDF): Promise<NewVault> {
		const keyId = toBase64Url(randomBytes(16));
		const recoveryCode = newRecoveryCode();

		const masterKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
		const rawMaster = new Uint8Array(await crypto.subtle.exportKey('raw', masterKey));

		const [derived, recoveryKey] = await Promise.all([
			deriveFromPassword(password, email, kdf),
			deriveFromRecoveryCode(readRecoveryCode(recoveryCode) ?? recoveryCode, email, kdf),
		]);

		const [passwordWrap, recoveryWrap] = await Promise.all([
			seal(derived.vaultKey, keyId, 'wrap:password', toBase64Url(rawMaster)),
			seal(recoveryKey, keyId, 'wrap:recovery', toBase64Url(rawMaster)),
		]);

		rawMaster.fill(0);

		return {
			material: { keyId, kdf: describeKdf(kdf), passwordWrap, recoveryWrap },
			authSecret: derived.authSecret,
			recoveryCode,
		};
	}

	async unlockWithPassword(password: string, email: string, vault: VaultView, userId: number): Promise<string> {
		const derived = await deriveFromPassword(password, email, parseKdf(vault.kdf));
		await this.unlockWithDerived(derived.vaultKey, vault, userId);
		return derived.authSecret;
	}

	async unlockWithDerived(vaultKey: CryptoKey, vault: UnlockableVault, userId: number | null): Promise<void> {
		const master = await this.unwrap(vaultKey, vault.keyId, 'wrap:password', vault.passwordWrap);
		await this.adoptMaster(vault.keyId, master, userId);
	}

	async unlockWithRecoveryCode(
		code: string,
		email: string,
		vault: RecoverableVault,
		userId: number | null,
	): Promise<void> {
		const normalised = readRecoveryCode(code);
		if (normalised === null) {
			throw new Error('That is not a recovery code for this application');
		}

		const recoveryKey = await deriveFromRecoveryCode(normalised, email, parseKdf(vault.kdf));
		const master = await this.unwrap(recoveryKey, vault.keyId, 'wrap:recovery', vault.recoveryWrap);
		await this.adoptMaster(vault.keyId, master, userId);
	}

	async verifyRecoveryCode(code: string, email: string, vault: RecoverableVault): Promise<boolean> {
		const normalised = readRecoveryCode(code);
		if (normalised === null) {
			return false;
		}

		// Certain, not a guess: the derived key either opens the wrap or fails GCM's auth tag, so a
		// wrong code cannot accidentally produce a plausible master key.
		try {
			const recoveryKey = await deriveFromRecoveryCode(normalised, email, parseKdf(vault.kdf));
			await open(recoveryKey, vault.keyId, 'wrap:recovery', vault.recoveryWrap);
			return true;
		} catch {
			return false;
		}
	}

	async adoptCreated(created: NewVault, vaultKey: CryptoKey, userId: number): Promise<void> {
		await this.unlockWithDerived(vaultKey, created.material, userId);
	}

	async restore(userId: number, vault: VaultView): Promise<boolean> {
		const key = await recallKey(userId, vault.keyId);
		if (key === null) {
			return false;
		}
		this.masterKey = key;
		this._keyId.set(vault.keyId);
		return true;
	}

	// The master key is unchanged, only re-wrapped; skipping this after a password change leaves a
	// vault nothing can open again, so callers must never treat it as optional.
	async rewrapForNewPassword(
		newPassword: string,
		email: string,
		vault: RecoverableVault,
	): Promise<{ material: VaultMaterial; authSecret: string }> {
		const { key, keyId } = this.require();
		const kdf = parseKdf(vault.kdf);

		const rawMaster = new Uint8Array(await this.exportMaster(key));
		const derived = await deriveFromPassword(newPassword, email, kdf);
		const passwordWrap = await seal(derived.vaultKey, keyId, 'wrap:password', toBase64Url(rawMaster));
		rawMaster.fill(0);

		return {
			material: { keyId, kdf: vault.kdf, passwordWrap, recoveryWrap: vault.recoveryWrap },
			authSecret: derived.authSecret,
		};
	}

	async replaceRecoveryCode(password: string, email: string, known?: VaultView): Promise<string> {
		const stored = known ?? (await this.vault());
		const { key, keyId } = this.require();
		const kdf = parseKdf(stored.kdf);

		const recoveryCode = newRecoveryCode();
		const recoveryKey = await deriveFromRecoveryCode(readRecoveryCode(recoveryCode) ?? recoveryCode, email, kdf);

		const rawMaster = new Uint8Array(await this.exportMaster(key));
		const recoveryWrap = await seal(recoveryKey, keyId, 'wrap:recovery', toBase64Url(rawMaster));
		rawMaster.fill(0);

		const derived = await deriveFromPassword(password, email, kdf);

		await firstValueFrom(
			this.http.post<VaultView>(`${this.baseUrl}/vault/recovery-code`, {
				currentSecret: derived.authSecret,
				vault: { keyId, kdf: stored.kdf, passwordWrap: stored.passwordWrap, recoveryWrap },
			}),
		);

		this._pendingRecoveryCode.set(recoveryCode);
		return recoveryCode;
	}

	async ensureRecoveryCode(password: string, email: string): Promise<void> {
		const stored = await this.vault();
		if (stored.acknowledgedAt !== null) {
			return;
		}
		await this.replaceRecoveryCode(password, email, stored);
	}

	async acknowledgeRecoveryCode(): Promise<void> {
		await firstValueFrom(this.http.post<void>(`${this.baseUrl}/vault/recovery-code/acknowledge`, {}));
		this._pendingRecoveryCode.set(null);
	}

	async rewrapFromUnlocked(
		newPassword: string,
		email: string,
		vault: RecoverableVault,
	): Promise<{ material: VaultMaterial; authSecret: string } | null> {
		// vault.keyId must match the unlocked key: without this guard, a second account signed in on
		// this machine could have its key written into somebody else's password reset.
		if (!this.unlocked() || this._keyId() !== vault.keyId) {
			return null;
		}
		return this.rewrapForNewPassword(newPassword, email, vault);
	}

	vault(): Promise<VaultView> {
		return firstValueFrom(this.http.get<VaultView>(`${this.baseUrl}/vault`));
	}

	async lock(): Promise<void> {
		this.masterKey = null;
		this._keyId.set(null);
		this._pendingRecoveryCode.set(null);
		await forgetKey();
	}

	private async unwrap(wrappingKey: CryptoKey, keyId: string, purpose: EnvelopePurpose, wrap: string): Promise<Bytes> {
		return fromBase64Url(await open(wrappingKey, keyId, purpose, wrap));
	}

	// The one extractable key in the application: rewrapForNewPassword must be able to re-seal these
	// same bytes under a new password without forcing a full re-upload. It never leaves this service.
	private async adoptMaster(keyId: string, rawMaster: Bytes, userId: number | null): Promise<void> {
		const key = await crypto.subtle.importKey('raw', rawMaster, { name: 'AES-GCM', length: 256 }, true, [
			'encrypt',
			'decrypt',
		]);
		rawMaster.fill(0);

		this.masterKey = key;
		this._keyId.set(keyId);

		if (userId !== null) {
			// Null on the reset screen: no session there for a remembered key to belong to.
			await rememberKey({ userId, keyId, key });
		}
	}

	private exportMaster(key: CryptoKey): Promise<ArrayBuffer> {
		return crypto.subtle.exportKey('raw', key);
	}
}

export class VaultLockedError extends Error {
	constructor() {
		super('This browser cannot read your files until you enter your password');
		this.name = 'VaultLockedError';
	}
}
