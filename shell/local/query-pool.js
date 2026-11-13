'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { unpacked } = require('./asar');

const TIMED_OUT = 'That took too long. Narrow the search and try again.';

/**
 * Index queries, run off the main process so the window never waits on SQLite. Each lane is one
 * worker taking one query at a time: quick position lookups never queue behind a report or a search.
 * A request sent with a channel replaces any earlier one on that channel that has not answered yet.
 */
class QueryPool {
	constructor(lanes, { script = path.join(__dirname, 'query-worker.js'), log = () => undefined } = {}) {
		this.lanes = new Map(
			Object.entries(lanes).map(([name, budgetMs]) => [name, new Lane(name, script, budgetMs, log)]),
		);
		this.seq = 0;
	}

	request(lane, index, method, args, channel = null) {
		const target = this.lanes.get(lane);
		if (!target) {
			return Promise.reject(failure('FAILED', `No query lane ${lane}`));
		}
		if (channel) {
			for (const one of this.lanes.values()) {
				one.drop((job) => job.channel === channel, 'SUPERSEDED', 'A newer request replaced this one.');
			}
		}
		return new Promise((resolve, reject) => {
			target.add({ seq: ++this.seq, index, method, args, channel, resolve, reject });
		});
	}

	/** Resolves once no worker holds the index open, so it can be rebuilt or deleted. */
	async release(index) {
		await Promise.all([...this.lanes.values()].map((lane) => lane.release(index, ++this.seq)));
	}

	close() {
		for (const lane of this.lanes.values()) {
			lane.close();
		}
	}
}

class Lane {
	constructor(name, script, budgetMs, log) {
		this.name = name;
		this.script = script;
		this.budgetMs = budgetMs;
		this.log = log;
		this.queue = [];
		this.running = null;
		this.worker = null;
		this.opened = new Set();
		this.waiting = new Map();
		this.closed = false;
	}

	add(job) {
		if (this.closed) {
			job.reject(failure('FAILED', 'The application is closing.'));
			return;
		}
		this.queue.push(job);
		this.next();
	}

	next() {
		if (this.running || this.queue.length === 0 || this.closed) {
			return;
		}
		const job = this.queue.shift();
		this.running = job;
		const worker = this.spawn();
		this.opened.add(job.index);
		job.timer = setTimeout(() => {
			if (this.running === job) {
				this.log(`query ${job.method} stopped after ${this.budgetMs / 1000} s`);
				this.restart();
				job.reject(failure('TIMEOUT', TIMED_OUT));
				this.next();
			}
		}, this.budgetMs);
		worker.postMessage({ seq: job.seq, method: job.method, index: job.index, args: job.args });
	}

	drop(matches, code, message) {
		for (const job of this.queue.filter(matches)) {
			this.queue.splice(this.queue.indexOf(job), 1);
			job.reject(failure(code, message));
		}
		const job = this.running;
		if (job && matches(job)) {
			// A query in flight cannot be interrupted from outside its thread: the worker goes instead.
			clearTimeout(job.timer);
			this.restart();
			job.reject(failure(code, message));
			this.next();
		}
	}

	release(index, seq) {
		this.drop((job) => job.index === index, 'FAILED', 'The database is being changed. Try again in a moment.');
		if (!this.worker || !this.opened.has(index)) {
			return Promise.resolve();
		}
		this.opened.delete(index);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.waiting.delete(seq);
				const job = this.restart();
				if (job) {
					clearTimeout(job.timer);
					job.reject(failure('FAILED', 'The database is being changed. Try again in a moment.'));
				}
				resolve();
				this.next();
			}, 5000);
			this.waiting.set(seq, () => {
				clearTimeout(timer);
				resolve();
			});
			this.worker.postMessage({ type: 'close', seq, index });
		});
	}

	spawn() {
		if (this.worker) {
			return this.worker;
		}
		const worker = new Worker(unpacked(this.script));
		worker.on('message', (message) => this.settle(worker, message));
		worker.on('error', (error) => this.lost(worker, error.message));
		worker.on('exit', (code) => this.lost(worker, `exit code ${code}`));
		this.worker = worker;
		this.opened.clear();
		return worker;
	}

	settle(worker, message) {
		if (worker !== this.worker) {
			return;
		}
		if (message.type === 'closed') {
			this.waiting.get(message.seq)?.();
			this.waiting.delete(message.seq);
			return;
		}
		const job = this.running;
		if (!job || job.seq !== message.seq) {
			return;
		}
		clearTimeout(job.timer);
		this.running = null;
		if (message.ok) {
			job.resolve(message.value);
		} else {
			job.reject(failure(message.code ?? 'FAILED', message.message ?? 'The query failed.'));
		}
		this.next();
	}

	lost(worker, reason) {
		if (worker !== this.worker) {
			return;
		}
		this.worker = null;
		this.opened.clear();
		for (const done of this.waiting.values()) {
			done();
		}
		this.waiting.clear();
		const job = this.running;
		this.running = null;
		if (job) {
			clearTimeout(job.timer);
			this.log(`query worker (${this.name}) stopped during ${job.method}: ${reason}`);
			job.reject(failure('FAILED', 'The database query stopped unexpectedly. Try again.'));
		}
		this.next();
	}

	// Returns the job that was running, for the caller to answer.
	restart() {
		const worker = this.worker;
		const job = this.running;
		this.worker = null;
		this.opened.clear();
		this.running = null;
		for (const done of this.waiting.values()) {
			done();
		}
		this.waiting.clear();
		if (worker) {
			void worker.terminate();
		}
		return job;
	}

	close() {
		this.closed = true;
		for (const job of this.queue.splice(0)) {
			job.reject(failure('FAILED', 'The application is closing.'));
		}
		const job = this.running;
		this.restart();
		if (job) {
			clearTimeout(job.timer);
			job.reject(failure('FAILED', 'The application is closing.'));
		}
	}
}

function failure(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

module.exports = { QueryPool };
