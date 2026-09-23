import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from './base64url';
import { EnvelopeError, isEnvelope, open, seal } from './envelope';
import { DEFAULT_KDF, deriveFromPassword, deriveFromRecoveryCode, describeKdf, parseKdf } from './kdf';
import { group, newRecoveryCode, readRecoveryCode } from './recovery-code';

// Real WebCrypto and compression, no stubs; PBKDF2 uses a lower iteration count than production.
const TEST_KDF = { name: 'PBKDF2-SHA256' as const, iterations: 100_000 };

const EMAIL = 'armand@example.com';

async function aesKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

describe('base64url', () => {
	it('round trips every byte value', () => {
		const bytes = new Uint8Array(256).map((_, i) => i);
		expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
	});

	it('uses no character that has to be escaped in a URL or a JSON string', () => {
		expect(toBase64Url(new Uint8Array([251, 255, 254]))).not.toMatch(/[+/=]/);
	});

	it('survives a value larger than the chunk it encodes in', () => {
		// Regression: spreading into String.fromCharCode overflowed the stack.
		const big = new Uint8Array(200_000).map((_, i) => i % 256);
		expect(fromBase64Url(toBase64Url(big)).length).toBe(big.length);
	});
});

describe('the envelope', () => {
	it('round trips a value', async () => {
		const key = await aesKey();
		const sealed = await seal(key, 'key-1', 'item', 'hello');

		expect(isEnvelope(sealed)).toBe(true);
		await expect(open(key, 'key-1', 'item', sealed)).resolves.toBe('hello');
	});

	it('round trips a long document through the compression path', async () => {
		const key = await aesKey();
		const long = `[Event "Grünfeld"]\n\n${'1. d4 Nf6 2. c4 g6 3. Nc3 d5 '.repeat(500)}*`;

		const sealed = await seal(key, 'key-1', 'item', long);
		await expect(open(key, 'key-1', 'item', sealed)).resolves.toBe(long);

		// PGN is repetitive; if this stops holding, the compression stopped happening.
		expect(sealed.length).toBeLessThan(long.length / 2);
	});

	it('round trips an empty value', async () => {
		const key = await aesKey();
		await expect(open(key, 'k', 'item', await seal(key, 'k', 'item', ''))).resolves.toBe('');
	});

	it('produces a different ciphertext every time', async () => {
		const key = await aesKey();
		const [first, second] = await Promise.all([seal(key, 'k', 'item', 'x'), seal(key, 'k', 'item', 'x')]);
		expect(first).not.toBe(second);
	});

	// The four refusals below are what the associated data is for: GCM alone proves a ciphertext was
	// not altered, not that it is the ciphertext that belongs in this field under this account's key.
	it('will not open a value under a different purpose', async () => {
		const key = await aesKey();
		const sealed = await seal(key, 'k', 'item', 'hello');
		await expect(open(key, 'k', 'collection-name', sealed)).rejects.toBeInstanceOf(EnvelopeError);
	});

	it('will not open a value sealed under a previous key generation', async () => {
		const key = await aesKey();
		const sealed = await seal(key, 'key-1', 'item', 'hello');
		await expect(open(key, 'key-2', 'item', sealed)).rejects.toBeInstanceOf(EnvelopeError);
	});

	it('will not open a value sealed under another key', async () => {
		const sealed = await seal(await aesKey(), 'k', 'item', 'hello');
		await expect(open(await aesKey(), 'k', 'item', sealed)).rejects.toBeInstanceOf(EnvelopeError);
	});

	it('refuses ciphertext that has been altered', async () => {
		const key = await aesKey();
		const parts = (await seal(key, 'k', 'item', 'hello')).split('.');

		// Flipped after decoding, not by editing a base64 character: the last character of a base64url
		// string carries fewer than six significant bits, so editing it could decode to the same bytes.
		const raw = fromBase64Url(parts[2]);
		raw[0] ^= 0x01;

		await expect(open(key, 'k', 'item', `${parts[0]}.${parts[1]}.${toBase64Url(raw)}`)).rejects.toBeInstanceOf(
			EnvelopeError,
		);
	});

	it('refuses a value that is not an envelope at all', async () => {
		await expect(open(await aesKey(), 'k', 'item', 'just some text')).rejects.toBeInstanceOf(EnvelopeError);
	});
});

describe('deriving from a password', () => {
	it('is deterministic', async () => {
		const first = await deriveFromPassword('correct horse battery staple', EMAIL, TEST_KDF);
		const second = await deriveFromPassword('correct horse battery staple', EMAIL, TEST_KDF);
		expect(first.authSecret).toBe(second.authSecret);
	});

	it('salts with the address, folded', async () => {
		const plain = await deriveFromPassword('pw', EMAIL, TEST_KDF);
		const shouted = await deriveFromPassword('pw', ' ARMAND@Example.com ', TEST_KDF);
		const elsewhere = await deriveFromPassword('pw', 'someone@example.com', TEST_KDF);

		expect(shouted.authSecret).toBe(plain.authSecret);
		expect(elsewhere.authSecret).not.toBe(plain.authSecret);
	});

	it('produces a 256-bit secret in base64url', async () => {
		const derived = await deriveFromPassword('pw', EMAIL, TEST_KDF);
		expect(derived.authSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('produces a vault key that cannot be read out of the browser', async () => {
		const derived = await deriveFromPassword('pw', EMAIL, TEST_KDF);
		expect(derived.vaultKey.extractable).toBe(false);
	});

	// The whole guarantee in one assertion: if this ever passes the wrong way, the split has
	// collapsed and the server could decrypt every account that signs in.
	it('sends a secret that does not open what the key it kept has sealed', async () => {
		const derived = await deriveFromPassword('pw', EMAIL, TEST_KDF);
		const sealed = await seal(derived.vaultKey, 'k', 'wrap:password', 'the master key');

		const secretAsKey = await crypto.subtle.importKey(
			'raw',
			fromBase64Url(derived.authSecret),
			{ name: 'AES-GCM' },
			false,
			['decrypt'],
		);

		await expect(open(secretAsKey, 'k', 'wrap:password', sealed)).rejects.toBeInstanceOf(EnvelopeError);
	});
});

describe('deriving from a recovery code', () => {
	it('ignores the grouping', async () => {
		const grouped = await deriveFromRecoveryCode('K4M2P-7XQW0-V3HRN-B8FTY-JZ1CS-9D', EMAIL, TEST_KDF);
		const bare = await deriveFromRecoveryCode('K4M2P7XQW0V3HRNB8FTYJZ1CS9D', EMAIL, TEST_KDF);

		const sealed = await seal(grouped, 'k', 'wrap:recovery', 'the master key');
		await expect(open(bare, 'k', 'wrap:recovery', sealed)).resolves.toBe('the master key');
	});

	it('is not the password derivation under another name', async () => {
		const password = await deriveFromPassword('K4M2P7XQW0V3HRNB8FTYJZ1CS9D', EMAIL, TEST_KDF);
		const recovery = await deriveFromRecoveryCode('K4M2P7XQW0V3HRNB8FTYJZ1CS9D', EMAIL, TEST_KDF);

		const sealed = await seal(recovery, 'k', 'wrap:recovery', 'the master key');
		await expect(open(password.vaultKey, 'k', 'wrap:recovery', sealed)).rejects.toBeInstanceOf(EnvelopeError);
	});
});

describe('the KDF descriptor', () => {
	it('round trips', () => {
		expect(parseKdf(describeKdf(DEFAULT_KDF))).toEqual(DEFAULT_KDF);
	});

	it('raises an iteration count that is too low to be worth anything', () => {
		expect(parseKdf('{"name":"PBKDF2-SHA256","iterations":1}').iterations).toBe(100_000);
	});

	it('refuses a function it does not implement', () => {
		expect(() => parseKdf('{"name":"scrypt","iterations":1}')).toThrow();
		expect(() => parseKdf('not json')).toThrow();
	});
});

describe('the recovery code', () => {
	it('is 26 characters, grouped for writing down', () => {
		const code = newRecoveryCode();
		expect(code).toMatch(/^([0-9A-Z]{5}-){5}[0-9A-Z]$/);
		expect(code.replace(/-/g, '')).toHaveLength(26);
	});

	it('leaves out the characters people confuse when copying', () => {
		for (let i = 0; i < 50; i++) {
			expect(newRecoveryCode()).not.toMatch(/[ILOU]/);
		}
	});

	it('does not repeat', () => {
		const codes = new Set(Array.from({ length: 200 }, () => newRecoveryCode()));
		expect(codes.size).toBe(200);
	});

	it('reads back what was generated, however it was typed', () => {
		const code = newRecoveryCode();
		const expected = code.replace(/-/g, '');

		expect(readRecoveryCode(code)).toBe(expected);
		expect(readRecoveryCode(code.toLowerCase())).toBe(expected);
		expect(readRecoveryCode(code.replace(/-/g, ' '))).toBe(expected);

		// The whole reason for Crockford's alphabet.
		const mistyped = expected.replace(/1/g, 'l').replace(/0/g, 'O');
		expect(readRecoveryCode(mistyped)).toBe(expected);
	});

	it('refuses something that is not a code, before spending a second deriving from it', () => {
		expect(readRecoveryCode('ABC')).toBeNull();
		expect(readRecoveryCode('!'.repeat(26))).toBeNull();
	});

	it('groups in fives', () => {
		expect(group('ABCDEFGHIJK')).toBe('ABCDE-FGHIJ-K');
	});
});
