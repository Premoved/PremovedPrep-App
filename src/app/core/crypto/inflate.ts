// Raw DEFLATE (RFC 1951) decoding, synchronous. The envelope's compressed values are a few
// kilobytes each, and DecompressionStream costs more to set up per value than the decoding itself:
// opening a collection of thousands of games spent most of its time building streams.

export class InflateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InflateError';
	}
}

const MAX_BITS = 15;

// Length codes 257..285: base length and extra bits.
const LENGTH_BASE = [
	3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];

// Distance codes 0..29: base distance and extra bits.
const DIST_BASE = [
	1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
	8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// The order code length code lengths are sent in, for a dynamic block.
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code: how many codes of each length, and the symbols in code order. */
interface Huffman {
	readonly counts: Uint16Array;
	readonly symbols: Uint16Array;
}

function huffman(lengths: ArrayLike<number>, from: number, count: number): Huffman {
	const counts = new Uint16Array(MAX_BITS + 1);
	for (let i = 0; i < count; i++) {
		counts[lengths[from + i]]++;
	}
	counts[0] = 0;

	// Over-subscribed sets cannot be decoded; incomplete ones are allowed (a single distance code).
	let left = 1;
	for (let bits = 1; bits <= MAX_BITS; bits++) {
		left = left * 2 - counts[bits];
		if (left < 0) {
			throw new InflateError('Over-subscribed Huffman code');
		}
	}

	const offsets = new Uint16Array(MAX_BITS + 2);
	for (let bits = 1; bits <= MAX_BITS; bits++) {
		offsets[bits + 1] = offsets[bits] + counts[bits];
	}
	const symbols = new Uint16Array(count);
	for (let i = 0; i < count; i++) {
		const length = lengths[from + i];
		if (length !== 0) {
			symbols[offsets[length]++] = i;
		}
	}
	return { counts, symbols };
}

let fixedLiterals: Huffman | null = null;
let fixedDistances: Huffman | null = null;

function fixedCodes(): [Huffman, Huffman] {
	if (fixedLiterals === null || fixedDistances === null) {
		const lengths = new Uint8Array(288);
		lengths.fill(8, 0, 144);
		lengths.fill(9, 144, 256);
		lengths.fill(7, 256, 280);
		lengths.fill(8, 280, 288);
		fixedLiterals = huffman(lengths, 0, 288);
		fixedDistances = huffman(new Uint8Array(30).fill(5), 0, 30);
	}
	return [fixedLiterals, fixedDistances];
}

class Reader {
	private readonly input: Uint8Array;
	private at = 0;
	private bitBuffer = 0;
	private bitCount = 0;

	constructor(input: Uint8Array) {
		this.input = input;
	}

	bits(need: number): number {
		let buffer = this.bitBuffer;
		while (this.bitCount < need) {
			if (this.at >= this.input.length) {
				throw new InflateError('Compressed data ends early');
			}
			buffer |= this.input[this.at++] << this.bitCount;
			this.bitCount += 8;
		}
		this.bitBuffer = buffer >>> need;
		this.bitCount -= need;
		return buffer & ((1 << need) - 1);
	}

	// Huffman codes are packed starting from their most significant bit.
	decode(code: Huffman): number {
		let value = 0;
		let first = 0;
		let index = 0;
		for (let length = 1; length <= MAX_BITS; length++) {
			value |= this.bits(1);
			const count = code.counts[length];
			if (value - first < count) {
				return code.symbols[index + (value - first)];
			}
			index += count;
			first = (first + count) << 1;
			value <<= 1;
		}
		throw new InflateError('Invalid Huffman code');
	}

	// A stored block starts on a byte boundary.
	align(): void {
		this.bitBuffer = 0;
		this.bitCount = 0;
	}

	byte(): number {
		if (this.at >= this.input.length) {
			throw new InflateError('Compressed data ends early');
		}
		return this.input[this.at++];
	}

	bytes(length: number): Uint8Array {
		if (this.at + length > this.input.length) {
			throw new InflateError('Compressed data ends early');
		}
		const out = this.input.subarray(this.at, this.at + length);
		this.at += length;
		return out;
	}
}

class Output {
	private buffer: Uint8Array;
	length = 0;

	constructor(estimate: number) {
		this.buffer = new Uint8Array(Math.max(1024, estimate));
	}

	private room(extra: number): void {
		if (this.length + extra <= this.buffer.length) {
			return;
		}
		let size = this.buffer.length * 2;
		while (size < this.length + extra) {
			size *= 2;
		}
		const grown = new Uint8Array(size);
		grown.set(this.buffer.subarray(0, this.length));
		this.buffer = grown;
	}

	push(byte: number): void {
		this.room(1);
		this.buffer[this.length++] = byte;
	}

	append(bytes: Uint8Array): void {
		this.room(bytes.length);
		this.buffer.set(bytes, this.length);
		this.length += bytes.length;
	}

	// Byte by byte on purpose: a copy may overlap what it is producing (distance < length).
	copy(distance: number, length: number): void {
		if (distance > this.length) {
			throw new InflateError('Distance points before the start of the data');
		}
		this.room(length);
		let from = this.length - distance;
		for (let i = 0; i < length; i++) {
			this.buffer[this.length++] = this.buffer[from++];
		}
	}

	result(): Uint8Array {
		return this.buffer.slice(0, this.length);
	}
}

function inflateBlock(reader: Reader, out: Output, literals: Huffman, distances: Huffman): void {
	for (;;) {
		const symbol = reader.decode(literals);
		if (symbol < 256) {
			out.push(symbol);
			continue;
		}
		if (symbol === 256) {
			return;
		}
		const lengthCode = symbol - 257;
		if (lengthCode >= LENGTH_BASE.length) {
			throw new InflateError('Invalid length code');
		}
		const length = LENGTH_BASE[lengthCode] + reader.bits(LENGTH_EXTRA[lengthCode]);
		const distanceCode = reader.decode(distances);
		if (distanceCode >= DIST_BASE.length) {
			throw new InflateError('Invalid distance code');
		}
		const distance = DIST_BASE[distanceCode] + reader.bits(DIST_EXTRA[distanceCode]);
		out.copy(distance, length);
	}
}

function dynamicCodes(reader: Reader): [Huffman, Huffman] {
	const literalCount = reader.bits(5) + 257;
	const distanceCount = reader.bits(5) + 1;
	const codeLengthCount = reader.bits(4) + 4;
	if (literalCount > 286 || distanceCount > 30) {
		throw new InflateError('Too many codes in a dynamic block');
	}

	const codeLengths = new Uint8Array(19);
	for (let i = 0; i < codeLengthCount; i++) {
		codeLengths[CODE_LENGTH_ORDER[i]] = reader.bits(3);
	}
	const lengthCode = huffman(codeLengths, 0, 19);

	const lengths = new Uint8Array(literalCount + distanceCount);
	let at = 0;
	while (at < lengths.length) {
		const symbol = reader.decode(lengthCode);
		if (symbol < 16) {
			lengths[at++] = symbol;
			continue;
		}
		let repeat: number;
		let value = 0;
		if (symbol === 16) {
			if (at === 0) {
				throw new InflateError('Repeat with no previous length');
			}
			value = lengths[at - 1];
			repeat = 3 + reader.bits(2);
		} else if (symbol === 17) {
			repeat = 3 + reader.bits(3);
		} else {
			repeat = 11 + reader.bits(7);
		}
		if (at + repeat > lengths.length) {
			throw new InflateError('Too many code lengths');
		}
		lengths.fill(value, at, at + repeat);
		at += repeat;
	}
	if (lengths[256] === 0) {
		throw new InflateError('No end-of-block code');
	}
	return [huffman(lengths, 0, literalCount), huffman(lengths, literalCount, distanceCount)];
}

/** Decodes raw DEFLATE data (no zlib or gzip header), as CompressionStream('deflate-raw') writes it. */
export function inflateRaw(input: Uint8Array): Uint8Array {
	const reader = new Reader(input);
	const out = new Output(input.length * 4);

	let last = 0;
	while (!last) {
		last = reader.bits(1);
		const type = reader.bits(2);
		if (type === 0) {
			reader.align();
			const length = reader.byte() | (reader.byte() << 8);
			const check = reader.byte() | (reader.byte() << 8);
			if ((length ^ 0xffff) !== check) {
				throw new InflateError('Stored block length does not match its complement');
			}
			out.append(reader.bytes(length));
		} else if (type === 1) {
			const [literals, distances] = fixedCodes();
			inflateBlock(reader, out, literals, distances);
		} else if (type === 2) {
			const [literals, distances] = dynamicCodes(reader);
			inflateBlock(reader, out, literals, distances);
		} else {
			throw new InflateError('Invalid block type');
		}
	}
	return out.result();
}
