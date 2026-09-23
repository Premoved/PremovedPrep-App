import { Bytes, fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8 } from './base64url';

// Envelope pmp1.<nonce>.<ciphertext>: AES-256-GCM, fresh 96-bit nonce; unknown prefixes rejected.
const PREFIX = 'pmp1';

const NONCE_BYTES = 12;

const RAW = 0;
const DEFLATE = 1;

// Half of what binds an envelope in place (see associatedData): GCM alone proves the ciphertext is
// unaltered but not that it belongs where it was found, so opening it requires naming key and purpose.
export type EnvelopePurpose = 'item' | 'collection-name' | 'wrap:password' | 'wrap:recovery';

export class EnvelopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EnvelopeError';
	}
}

export async function seal(
	key: CryptoKey,
	keyId: string,
	purpose: EnvelopePurpose,
	plaintext: string,
): Promise<string> {
	const nonce = randomBytes(NONCE_BYTES);
	const body = await pack(plaintext);

	const sealed = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce, additionalData: associatedData(keyId, purpose) },
		key,
		body,
	);

	return `${PREFIX}.${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(sealed))}`;
}

export async function open(key: CryptoKey, keyId: string, purpose: EnvelopePurpose, envelope: string): Promise<string> {
	const parts = envelope.split('.');
	if (parts.length !== 3 || parts[0] !== PREFIX) {
		throw new EnvelopeError('This value is not in a format this version can read');
	}

	let opened: ArrayBuffer;
	try {
		opened = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromBase64Url(parts[1]), additionalData: associatedData(keyId, purpose) },
			key,
			fromBase64Url(parts[2]),
		);
	} catch {
		// One message for every failure mode: distinguishing "wrong key" from "altered ciphertext"
		// would tell an attacker which one they hit.
		throw new EnvelopeError('This could not be decrypted with the key for this account');
	}

	return unpack(new Uint8Array(opened));
}

export function isEnvelope(value: string | null | undefined): boolean {
	return typeof value === 'string' && /^pmp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

// Binds the ciphertext to the key and field it was sealed for, so a value moved to another field or
// re-encrypted under a different key fails as authentication rather than decrypting successfully.
function associatedData(keyId: string, purpose: EnvelopePurpose): Bytes {
	return utf8(`${PREFIX}|${keyId}|${purpose}`);
}

async function pack(plaintext: string): Promise<Bytes> {
	const body = utf8(plaintext);
	const compressed = await deflate(body);

	// Only kept when it actually helps: short values (a folder name) come out longer compressed.
	if (compressed === null || compressed.length >= body.length) {
		return prefixed(RAW, body);
	}
	return prefixed(DEFLATE, compressed);
}

async function unpack(body: Bytes): Promise<string> {
	if (body.length === 0) {
		throw new EnvelopeError('This value decrypted to nothing');
	}

	const content = body.subarray(1);
	switch (body[0]) {
		case RAW:
			return fromUtf8(content);
		case DEFLATE: {
			const expanded = await inflate(content);
			if (expanded === null) {
				throw new EnvelopeError('This value is compressed and this browser cannot expand it');
			}
			return fromUtf8(expanded);
		}
		default:
			throw new EnvelopeError('This value is in a format this version cannot read');
	}
}

function prefixed(marker: number, body: Uint8Array): Bytes {
	const out = new Uint8Array(body.length + 1);
	out[0] = marker;
	out.set(body, 1);
	return out;
}

// Compression is an optimisation, never a requirement: any failure (API missing, stream refusing)
// answers null and the value is sealed uncompressed instead.
async function deflate(body: Bytes): Promise<Bytes | null> {
	if (typeof CompressionStream === 'undefined') {
		return null;
	}
	try {
		return await pump(new CompressionStream('deflate-raw'), body);
	} catch {
		return null;
	}
}

// Unlike deflate(), a compressed value that will not expand must surface as an error, not be
// papered over; only the API being absent (not a decompression failure) returns null here.
async function inflate(body: Uint8Array): Promise<Bytes | null> {
	if (typeof DecompressionStream === 'undefined') {
		return null;
	}
	return pump(new DecompressionStream('deflate-raw'), body);
}

async function pump(through: GenericTransformStream, body: Uint8Array): Promise<Bytes> {
	const writer = through.writable.getWriter();
	// Not awaited before reading starts: backpressure means a write large enough to fill the
	// transform's queue would block waiting on a reader that has not been started yet.
	void writer.write(body).then(
		() => writer.close(),
		() => undefined,
	);

	const reader = through.readable.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		length += value.length;
	}

	const out = new Uint8Array(length);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}
