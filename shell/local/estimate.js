'use strict';

// How long a database run has left, from how fast it is going.
//
// Counting positions has two steps: reading the games (done and total in games), then counting
// (in work units). The time left covers both: the rest of the step in progress at its measured
// speed, plus, while still reading, the counting to come. That one is not measured yet, so it is
// worked out from the size the positions file is heading for and from how fast counting went on
// this computer the last time (seconds per byte of index). Once counting runs, its own speed takes
// over within a few minutes. Indexing a search database reads a PGN (in bytes) and has no counting.
//
// A speed is measured over the last WINDOW_MS of work: long enough that a dense stretch does not
// swing it, short enough to follow a real change. Two reports further apart than PAUSE_MS mean the
// computer slept or the process was paused: that gap is left out, so a pause does not read as
// slowness. Other runs (preparing, compacting, export, import) have one step and only the first part applies.

const PAUSE_MS = 3 * 60_000;
const WINDOW_MS = 20 * 60_000;
// Too early for a speed to mean much: no time is shown before this much of a step has been timed.
const SETTLE_MS = 45_000;
// Counting's own speed replaces the remembered one over this much counting.
const BLEND_MS = 3 * 60_000;
// Seconds of counting per byte of index, until this computer has measured its own.
const DEFAULT_COUNT_SECONDS_PER_BYTE = 150 / 1e9;
// For guessing how many of the 256 buckets a small addition reaches: about one position per 12 bytes of PGN.
const PGN_BYTES_PER_POSITION = 12;
const BUCKETS = 256;

class Estimate {
	// counting: whether counting follows the reading (indexing positions); perUnit: positions per
	// unit read, by default per byte of PGN.
	constructor(countSecondsPerByte, { counting = true, perUnit = 1 / PGN_BYTES_PER_POSITION } = {}) {
		this.counting = counting;
		this.perUnit = perUnit;
		this.known = countSecondsPerByte > 0;
		this.countRate = this.known ? countSecondsPerByte : DEFAULT_COUNT_SECONDS_PER_BYTE;
		this.stage = null;
		this.samples = [];
		this.active = 0;
		this.work = 0;
		this.lastAt = null;
		this.lastDone = 0;
		this.read = null;
		this.count = null;
	}

	// Returns { secondsLeft }, null until there is enough to go on.
	update(stage, done, total, indexBytes, at = Date.now()) {
		if (stage !== this.stage) {
			this.stage = stage;
			this.samples = [];
			this.active = 0;
			this.work = 0;
			this.lastAt = null;
		}
		if (this.lastAt !== null) {
			const gap = at - this.lastAt;
			// Across a pause, neither the time nor the little work just before it counts.
			if (gap > 0 && gap <= PAUSE_MS) {
				this.active += gap;
				this.work += Math.max(0, done - this.lastDone);
			}
		}
		this.lastAt = at;
		this.lastDone = done;
		this.samples.push({ active: this.active, work: this.work });
		while (this.samples.length > 2 && this.active - this.samples[1].active >= WINDOW_MS) {
			this.samples.shift();
		}

		if (stage === 'reading') {
			this.read ??= { done, indexBytes };
			return { secondsLeft: this.readingLeft(done, total, indexBytes) };
		}
		if (stage === 'counting') {
			this.count ??= { done, total, indexBytes };
			this.count.last = done;
			this.count.active = this.active;
			return { secondsLeft: this.countingLeft(done, total, indexBytes) };
		}
		return { secondsLeft: this.active >= SETTLE_MS ? this.stepLeft(done, total) : null };
	}

	// Units per second over the window, or null while there is too little to measure.
	speed() {
		const first = this.samples[0];
		const last = this.samples[this.samples.length - 1];
		const span = last.active - first.active;
		if (span < 15_000 || last.work <= first.work) {
			return null;
		}
		return ((last.work - first.work) * 1000) / span;
	}

	stepLeft(done, total) {
		const speed = this.speed();
		return speed === null ? null : Math.max(0, total - done) / speed;
	}

	readingLeft(done, total, indexBytes) {
		if (this.active < SETTLE_MS) {
			return null;
		}
		const reading = this.stepLeft(done, total);
		const read = done - this.read.done;
		if (reading === null || read <= 0) {
			return null;
		}
		if (!this.counting) {
			return reading;
		}
		// The index grows with what is read: at the same pace for the rest of the file.
		const growth = Math.max(0, indexBytes - this.read.indexBytes) / read;
		const finalBytes = indexBytes + growth * Math.max(0, total - done);
		// Every bucket after a large addition; only some after a handful of games.
		const positions = (total - this.read.done) * this.perUnit;
		const reached = 1 - Math.exp(-positions / BUCKETS);
		return reading + this.countRate * finalBytes * reached;
	}

	countingLeft(done, total, indexBytes) {
		const share = total > 0 ? Math.max(0, total - done) / total : 0;
		const remembered = this.countRate * indexBytes * share;
		const measured = this.stepLeft(done, total);
		if (measured === null) {
			return remembered;
		}
		const weight = Math.min(1, this.active / BLEND_MS);
		return weight * measured + (1 - weight) * remembered;
	}

	// What this run measured of counting, blended with what was known before; null when it counted too little.
	countSecondsPerByte() {
		const count = this.count;
		if (!count || count.total <= 0 || count.indexBytes <= 0) {
			return null;
		}
		const share = (count.last - count.done) / count.total;
		if (share < 0.25 || count.active < 30_000) {
			return null;
		}
		const measured = count.active / 1000 / (count.indexBytes * share);
		return this.known ? (measured + this.countRate) / 2 : measured;
	}
}

module.exports = { Estimate };
