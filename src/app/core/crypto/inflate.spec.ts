import { describe, expect, it } from 'vitest';
import { InflateError, inflateRaw } from './inflate';

// Compressed by the platform's own encoder, the one the envelope seals with. Written and read by
// hand: the test environment has CompressionStream but not Blob.stream() or Response bodies.
async function deflateRaw(text: string): Promise<Uint8Array> {
	const through = new CompressionStream('deflate-raw');
	const writer = through.writable.getWriter();
	void writer.write(new TextEncoder().encode(text)).then(() => writer.close());

	const reader = through.readable.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

const GAME = `[Event "Romanian Ch"]
[White "Popescu, Andrei-Constantin"]
[Black "Ionescu-Vasilescu, Mihai"]
[Result "1-0"]

1. e4 { [%cal Gg1f3] } 1... e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 (6. d3 b5 7. Bb3 d6) 6... b5 1-0
`;

describe('inflateRaw', () => {
	it('expands what the platform compressed', async () => {
		for (const text of ['', 'x', GAME, GAME.repeat(200), 'ș ț ă î â — ♔♕ 象棋'.repeat(300)]) {
			const expanded = inflateRaw(await deflateRaw(text));
			expect(new TextDecoder().decode(expanded)).toBe(text);
		}
	});

	it('expands text with no repetition, which compresses into larger blocks', async () => {
		const noise = Array.from({ length: 50_000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join('');
		expect(new TextDecoder().decode(inflateRaw(await deflateRaw(noise)))).toBe(noise);
	});

	it('refuses cut-short data rather than returning part of it', async () => {
		const packed = await deflateRaw(GAME.repeat(20));
		for (const length of [1, 5, Math.floor(packed.length / 2), packed.length - 1]) {
			expect(() => inflateRaw(packed.subarray(0, length))).toThrow(InflateError);
		}
	});

	it('refuses an invalid block type', () => {
		// First bit: last block; next two bits: type 3, which does not exist.
		expect(() => inflateRaw(new Uint8Array([0b111]))).toThrow(InflateError);
	});
});
