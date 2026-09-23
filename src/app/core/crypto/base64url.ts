// Unpadded base64url (RFC 4648 §5): safe in URLs, JSON and the Postgres CHECK constraint.
// ArrayBuffer-backed, not SharedArrayBuffer: WebCrypto's BufferSource excludes the shared case.
export type Bytes = Uint8Array<ArrayBuffer>;

export function toBase64Url(bytes: Uint8Array): string {
	// Chunked rather than String.fromCharCode(...bytes): spreading a megabyte-long array into
	// arguments overflows the call stack, and a saved PGN can be a megabyte.
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Bytes {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));

	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function utf8(value: string): Bytes {
	const encoded = new TextEncoder().encode(value);
	// A view over the same memory, not a copy: encode() always allocates a plain ArrayBuffer.
	return new Uint8Array(encoded.buffer as ArrayBuffer, encoded.byteOffset, encoded.byteLength);
}

export function fromUtf8(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

// The only source of cryptographically random bytes in this application.
export function randomBytes(length: number): Bytes {
	return crypto.getRandomValues(new Uint8Array(length));
}
