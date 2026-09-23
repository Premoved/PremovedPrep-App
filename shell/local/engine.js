'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROBE_TIMEOUT_MS = 8_000;

const OPTION = /^option name (.+?) type (\w+)(?: .*?)?(?: max (-?\d+))?\s*$/;

class Engines {
	constructor(settings, emit) {
		this.settings = settings;
		this.emit = emit;
		this.sessions = new Map();
	}

	list() {
		return this.settings.value.engines.map((engine) => ({
			id: engine.id,
			name: engine.name,
			reportedName: engine.reportedName ?? null,
			author: engine.author ?? null,
			threads: engine.threads !== false,
			maxThreads: engine.maxThreads ?? os.cpus().length,
			maxHashMb: engine.maxHashMb ?? null,
			multiPv: engine.multiPv !== false,
			bundled: engine.bundled === true,
		}));
	}

	adoptBundled(file, name) {
		if (!file || !fs.existsSync(file)) {
			return null;
		}
		this.forgetOtherBundled(file);
		const known = this.settings.value.engines.find((engine) => engine.path === file);
		if (known) {
			if (known.bundled !== true) {
				this.settings.update({
					engines: this.settings.value.engines.map((engine) =>
						engine === known ? { ...engine, bundled: true } : engine,
					),
				});
				return { ...known, bundled: true };
			}
			return known;
		}
		return this.add(file, name, true);
	}

	// Settings are shared by every installation on this machine, and remove() refuses a bundled
	// engine: without this, an entry from a previous location stays in the list for good.
	forgetOtherBundled(file) {
		const stale = this.settings.value.engines.filter((engine) => engine.bundled === true && engine.path !== file);
		if (stale.length === 0) {
			return;
		}
		for (const engine of stale) {
			for (const [sessionId, session] of this.sessions) {
				if (session.engineId === engine.id) {
					this.close(sessionId);
				}
			}
		}
		this.settings.update({ engines: this.settings.value.engines.filter((engine) => !stale.includes(engine)) });
	}

	async add(file, name, bundled = false) {
		const probed = await probe(file);
		const engine = {
			id: this.settings.takeEngineId(),
			name: name ?? probed.reportedName ?? path.basename(file),
			path: file,
			bundled,
			...probed,
		};
		this.settings.update({ engines: [...this.settings.value.engines, engine] });
		return engine;
	}

	remove(id) {
		const engine = this.settings.value.engines.find((entry) => entry.id === id);
		if (!engine || engine.bundled === true) {
			return false;
		}
		this.settings.update({ engines: this.settings.value.engines.filter((entry) => entry.id !== id) });
		for (const [sessionId, session] of this.sessions) {
			if (session.engineId === id) {
				this.close(sessionId);
			}
		}
		return true;
	}

	open(engineId) {
		const engine = this.settings.value.engines.find((entry) => entry.id === engineId);
		if (!engine) {
			throw new Error(`No engine with id ${engineId}`);
		}

		const child = spawn(engine.path, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
		const sessionId = crypto.randomUUID();
		this.sessions.set(sessionId, { engineId, child });

		lines(child.stdout, (line) => this.emit('engine.line', { sessionId, line }));

		const finish = () => {
			if (this.sessions.delete(sessionId)) {
				this.emit('engine.closed', { sessionId });
			}
		};
		child.on('exit', finish);
		child.on('error', finish);

		return { sessionId, engineId, engineName: engine.name };
	}

	send(sessionId, command) {
		const session = this.sessions.get(sessionId);
		if (!session || !allowedCommand(command)) {
			return;
		}
		session.child.stdin.write(`${command}\n`);
	}

	close(sessionId) {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		this.sessions.delete(sessionId);
		// quit lets the engine free its hash table; killing it alone leaves that to the kernel.
		try {
			session.child.stdin.write('quit\n');
		} catch {
			// Process already gone.
		}
		setTimeout(() => session.child.kill(), 1_000).unref?.();
	}

	closeAll() {
		for (const sessionId of [...this.sessions.keys()]) {
			this.close(sessionId);
		}
	}
}

function probe(file) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
		} catch (error) {
			reject(error);
			return;
		}

		const found = {
			reportedName: null,
			author: null,
			threads: false,
			maxThreads: null,
			maxHashMb: null,
			multiPv: false,
		};

		const done = (error) => {
			clearTimeout(timer);
			try {
				child.stdin.write('quit\n');
			} catch {
				// Process already gone.
			}
			setTimeout(() => child.kill(), 500).unref?.();
			if (error) {
				reject(error);
			} else {
				resolve(found);
			}
		};

		const timer = setTimeout(() => done(new Error('The engine did not answer uci')), PROBE_TIMEOUT_MS);

		child.on('error', (error) => done(error));

		lines(child.stdout, (line) => {
			if (line.startsWith('id name ')) {
				found.reportedName = line.slice(8).trim();
			} else if (line.startsWith('id author ')) {
				found.author = line.slice(10).trim();
			} else if (line.startsWith('option name ')) {
				read(found, line);
			} else if (line.trim() === 'uciok') {
				done(null);
			}
		});

		child.stdin.write('uci\n');
	});
}

function read(found, line) {
	const option = OPTION.exec(line);
	if (!option) {
		return;
	}
	const [, name, , max] = option;
	const ceiling = max === undefined ? null : Number(max);
	if (name === 'Threads') {
		found.threads = true;
		found.maxThreads = ceiling;
	} else if (name === 'Hash') {
		found.maxHashMb = ceiling;
	} else if (name === 'MultiPV') {
		found.multiPv = true;
	}
}

function lines(stream, onLine) {
	let buffer = '';
	stream.setEncoding('utf8');
	stream.on('data', (chunk) => {
		buffer += chunk;
		let at = buffer.indexOf('\n');
		while (at !== -1) {
			const line = buffer.slice(0, at).replace(/\r$/, '');
			buffer = buffer.slice(at + 1);
			if (line.length > 0) {
				onLine(line);
			}
			at = buffer.indexOf('\n');
		}
	});
}

// Allow-listed: setoption's Debug Log File/EvalFile/SyzygyPath can read or write arbitrary paths.
const SEND_SIMPLE = new Set(['uci', 'isready', 'ucinewgame', 'stop', 'quit', 'ponderhit']);
const SEND_OPTION =
	/^setoption name (Threads|Hash|MultiPV|UCI_ShowWDL|UCI_Chess960|Ponder) value (\d{1,7}|true|false)$/;
const SEND_GO = /^go( (infinite|ponder|(depth|nodes|movetime|mate|movestogo|wtime|btime|winc|binc) \d{1,12}))*$/;
const SEND_POSITION =
	/^position (startpos|fen [pnbrqkPNBRQK1-8/]{15,90} [wb] (-|[KQkqA-Ha-h]{1,4}) (-|[a-h][36])( \d{1,4} \d{1,4})?)( moves( [a-h][1-8][a-h][1-8][qrbn]?){1,1000})?$/;

function allowedCommand(command) {
	if (typeof command !== 'string' || command.length > 8000 || /[\r\n\0]/.test(command)) {
		return false;
	}
	return SEND_SIMPLE.has(command) || SEND_OPTION.test(command) || SEND_GO.test(command) || SEND_POSITION.test(command);
}

module.exports = { Engines };
