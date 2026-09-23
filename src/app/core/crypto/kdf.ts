import { Bytes, toBase64Url, utf8 } from './base64url';

// One stretch, then HKDF into authSecret (sent instead of the password) and vaultKey (never sent).
// authSecret reveals nothing about vaultKey.
export interface KdfParameters {
	readonly name: 'PBKDF2-SHA256';
	readonly iterations: number;
}

// OWASP's current figure for PBKDF2-HMAC-SHA256: about a second on a mid-range laptop, paid once per
// sign-in, and the whole of what stands between a stolen database of wraps and someone's preparation.
export const DEFAULT_KDF: KdfParameters = { name: 'PBKDF2-SHA256', iterations: 600_000 };

export function parseKdf(descriptor: string): KdfParameters {
	let parsed: unknown;
	try {
		parsed = JSON.parse(descriptor);
	} catch {
		throw new Error('This account records an encryption setting this version cannot read');
	}

	const record = parsed as Partial<KdfParameters>;
	if (record?.name !== 'PBKDF2-SHA256' || typeof record.iterations !== 'number') {
		throw new Error('This account records an encryption setting this version cannot read');
	}

	// Server-provided iteration count: floor blocks downgrade attacks; ceiling guards against a hang.
	const iterations = Math.min(Math.max(record.iterations, 100_000), 5_000_000);
	return { name: 'PBKDF2-SHA256', iterations };
}

export function describeKdf(kdf: KdfParameters): string {
	return JSON.stringify({ name: kdf.name, iterations: kdf.iterations });
}

export interface DerivedSecrets {
	readonly authSecret: string;
	readonly vaultKey: CryptoKey;
}

export async function deriveFromPassword(password: string, email: string, kdf: KdfParameters): Promise<DerivedSecrets> {
	const stretched = await stretch(password, await saltFor('kdf', email), kdf);

	const [authSecret, vaultKey] = await Promise.all([
		expandToSecret(stretched, 'pmp/auth/v1'),
		expandToKey(stretched, 'pmp/vault/v1'),
	]);

	return { authSecret, vaultKey };
}

// A separate stretch with its own salt, not a branch off the password's: the two must stay
// independent, since the recovery code exists precisely for when the password is what was lost.
export async function deriveFromRecoveryCode(
	recoveryCode: string,
	email: string,
	kdf: KdfParameters,
): Promise<CryptoKey> {
	const stretched = await stretch(normaliseCode(recoveryCode), await saltFor('recovery', email), kdf);
	return expandToKey(stretched, 'pmp/recovery/v1');
}

async function stretch(secret: string, salt: Bytes, kdf: KdfParameters): Promise<Bytes> {
	const material = await crypto.subtle.importKey('raw', utf8(secret), 'PBKDF2', false, ['deriveBits']);

	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: salt, iterations: kdf.iterations, hash: 'SHA-256' },
		material,
		256,
	);
	return new Uint8Array(bits);
}

async function expandToSecret(stretched: Bytes, info: string): Promise<string> {
	return toBase64Url(new Uint8Array(await expand(stretched, info)));
}

async function expandToKey(stretched: Bytes, info: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		await expand(stretched, info),
		{ name: 'AES-GCM', length: 256 },
		false, // not extractable: nothing in this application has a reason to read this key's bytes
		['encrypt', 'decrypt'],
	);
}

async function expand(stretched: Bytes, info: string): Promise<ArrayBuffer> {
	const material = await crypto.subtle.importKey('raw', stretched, 'HKDF', false, ['deriveBits']);

	return crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
		material,
		256,
	);
}

// Salted with the email address: it is unique per account and needs no secrecy, so /prelogin can
// answer an unknown address exactly like a known one with no stored salt to distinguish them.
async function saltFor(purpose: 'kdf' | 'recovery', email: string): Promise<Bytes> {
	const digest = await crypto.subtle.digest('SHA-256', utf8(`pmp/${purpose}/v1|${email.trim().toLowerCase()}`));
	return new Uint8Array(digest);
}

// Whitespace and case are what a person retyping a recovery code gets wrong; neither is meaningful.
function normaliseCode(code: string): string {
	return code.replace(/[\s-]/g, '').toUpperCase();
}
