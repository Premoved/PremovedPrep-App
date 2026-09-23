import { describe, expect, it } from 'vitest';
import {
	DeviceCapabilities,
	hashStepsFor,
	maxThreads,
	recommendedHashMb,
	recommendedThreads,
	shareHashMb,
	shareThreads,
} from './engine-capabilities';
import { EngineDefinition, engineById } from './engine-catalogue';

const LOCAL = engineById('local');

const SINGLE_THREADED: EngineDefinition = { ...LOCAL, id: 'single-threaded', threads: false };

function device(overrides: Partial<DeviceCapabilities> = {}): DeviceCapabilities {
	return { cores: 8, memoryGb: 8, ...overrides };
}

describe('recommendedThreads', () => {
	it('leaves one core to the page', () => {
		expect(recommendedThreads(device({ cores: 8 }), LOCAL)).toBe(7);
	});

	it('never drops below one, however few cores are reported', () => {
		expect(recommendedThreads(device({ cores: 1 }), LOCAL)).toBe(1);
	});

	it('is one on a build that cannot use threads at all', () => {
		expect(recommendedThreads(device({ cores: 16 }), SINGLE_THREADED)).toBe(1);
		expect(maxThreads(device({ cores: 16 }), SINGLE_THREADED)).toBe(1);
	});
});

describe('recommendedHashMb', () => {
	it('takes an eighth of the machine, rounded down to a power of two', () => {
		expect(recommendedHashMb(device({ memoryGb: 8 }), LOCAL)).toBe(1024);
		expect(recommendedHashMb(device({ memoryGb: 4 }), LOCAL)).toBe(512);
		expect(recommendedHashMb(device({ memoryGb: 0.5 }), LOCAL)).toBe(64);
	});

	it('never exceeds what the build can address', () => {
		const capped: EngineDefinition = { ...LOCAL, maxHashMb: 256 };
		expect(recommendedHashMb(device({ memoryGb: 8 }), capped)).toBe(256);
		expect(hashStepsFor(capped).at(-1)).toBe(256);
	});

	it('guesses conservatively where the browser will not say', () => {
		expect(recommendedHashMb(device({ memoryGb: null }), LOCAL)).toBe(256);
	});

	it('still returns a usable size on a machine too small for any step', () => {
		expect(recommendedHashMb(device({ memoryGb: 0.1 }), LOCAL)).toBe(16);
	});
});

describe('sharing one machine between boards', () => {
	it('gives a single board everything the recommendation allows', () => {
		expect(shareThreads(7, 1)).toBe(7);
		expect(shareHashMb(1024, 1)).toBe(1024);
	});

	it('halves for a second board', () => {
		expect(shareThreads(7, 2)).toBe(3);
		expect(shareHashMb(1024, 2)).toBe(512);
	});

	it('snaps memory down to a step the slider has', () => {
		expect(shareHashMb(1024, 3)).toBe(256);
	});

	it('never advises less than one thread, however many boards are open', () => {
		expect(shareThreads(2, 9)).toBe(1);
		expect(shareThreads(1, 1)).toBe(1);
	});

	it('treats a nonsense count as a single board rather than dividing by zero', () => {
		expect(shareThreads(7, 0)).toBe(7);
		expect(shareHashMb(1024, 0)).toBe(1024);
	});
});
