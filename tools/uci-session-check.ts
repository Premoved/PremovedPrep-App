import { Timers, UciSession } from '../src/app/core/engine/uci-session';

declare const process: { exit(code: number): never };

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail: unknown = ''): void {
	if (ok) {
		passed++;
		console.log('  ok    ' + name);
	} else {
		failures.push(name);
		console.log('  FAIL  ' + name + '   -- ' + JSON.stringify(detail));
	}
}

function same(name: string, actual: unknown, expected: unknown): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	check(name, ok, ok ? '' : { actual, expected });
}

class FakeTimers implements Timers {
	private now = 0;
	private next = 1;
	private readonly due = new Map<number, { at: number; run: () => void }>();

	set(run: () => void, ms: number): unknown {
		const handle = this.next++;
		this.due.set(handle, { at: this.now + ms, run });
		return handle;
	}

	clear(handle: unknown): void {
		if (typeof handle === 'number') {
			this.due.delete(handle);
		}
	}

	advance(ms: number): void {
		const until = this.now + ms;
		for (;;) {
			const ready = [...this.due.entries()]
				.filter(([, timer]) => timer.at <= until)
				.sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
			if (ready.length === 0) {
				break;
			}
			const [handle, timer] = ready[0];
			this.due.delete(handle);
			this.now = timer.at;
			timer.run();
		}
		this.now = until;
	}

	get pending(): number {
		return this.due.size;
	}
}

function session(options: { readyTimeoutMs?: number; stopTimeoutMs?: number } = {}) {
	const sent: string[] = [];
	const warnings: string[] = [];
	let idle = 0;
	const timers = new FakeTimers();

	const uci = new UciSession(
		{
			send: (command) => sent.push(command),
			onIdle: () => idle++,
			onWarning: (message) => warnings.push(message),
		},
		{
			setOptions: ['name Threads value 4', 'name Hash value 256', 'name MultiPV value 2'],
			readyTimeoutMs: options.readyTimeoutMs ?? 15_000,
			stopTimeoutMs: options.stopTimeoutMs ?? 2_000,
			timers,
		},
	);

	return {
		uci,
		timers,
		sent,
		warnings,
		idleCount: () => idle,
		drain: () => sent.splice(0),
		handshake: () => {
			uci.line('id name Stockfish 17');
			uci.line('uciok');
			uci.line('readyok');
		},
	};
}

console.log('\nThe handshake\n');

{
	const s = session();
	s.uci.begin();
	same('begin asks for the handshake and nothing else', s.drain(), ['uci']);

	s.uci.search(START, null);
	same('a position asked for before uciok is not sent to the engine', s.drain(), []);

	s.uci.line('uciok');
	same('the options go out once the engine says uciok', s.drain(),
		['setoption name Threads value 4', 'setoption name Hash value 256',
			'setoption name MultiPV value 2', 'isready']);

	s.uci.line('readyok');
	same('and the parked position is searched the moment it says readyok', s.drain(),
		[`position fen ${START}`, 'go infinite']);
}

{
	const s = session();
	s.uci.begin();
	s.uci.search(START, null);
	s.uci.line('uciok');
	const beforeReady = s.sent.filter((command) => command.startsWith('go'));
	check('no `go` is ever sent before readyok', beforeReady.length === 0, beforeReady);
}

{
	const s = session({ readyTimeoutMs: 15_000 });
	s.uci.begin();
	s.uci.search(START, null);
	s.drain();

	s.timers.advance(14_999);
	same('an engine that is merely slow is still waited for', s.drain(), []);

	s.timers.advance(2);
	const sent = s.drain();
	check('an engine that never answers the handshake does not hang the panel',
		sent.includes('go infinite'), sent);
	check('  ... and it says so rather than recovering silently',
		s.warnings.length === 1 && s.warnings[0].includes('handshake'), s.warnings);
}

{
	const s = session({ readyTimeoutMs: 1_000 });
	s.uci.begin();
	s.uci.search(START, null);
	s.uci.line('uciok');
	s.drain();
	s.timers.advance(1_001);
	check('the same when it answers uciok and then goes quiet',
		s.drain().includes('go infinite'), s.sent);
	check('  ... naming which half it was waiting for',
		s.warnings.some((w) => w.includes('readyok')), s.warnings);
}

console.log('\nMoving between positions\n');

{
	const s = session();
	s.uci.begin();
	s.handshake();
	s.uci.search(START, null);
	s.drain();

	s.uci.search(AFTER_E4, null);
	same('a position change asks the running search to stop first', s.drain(), ['stop']);

	check('and the engine is not yet searching the new one', !s.uci.acceptsInfo);

	s.uci.line('bestmove e2e4');
	same('the bestmove that ends the old search starts the new one', s.drain(),
		[`position fen ${AFTER_E4}`, 'go infinite']);
	check('  ... and info lines count again from here', s.uci.acceptsInfo);
}

{
	const s = session();
	s.uci.begin();
	s.handshake();
	s.uci.search(START, null);
	check('info is accepted during a settled search', s.uci.acceptsInfo);

	s.uci.search(AFTER_E4, null);
	check('info is refused once the position has moved on', !s.uci.acceptsInfo);

	s.uci.line('bestmove e2e4');
	check('and accepted again once the new search has actually started', s.uci.acceptsInfo);
}

{
	const s = session();
	s.uci.begin();
	s.handshake();
	s.uci.search(START, null);
	s.drain();

	s.uci.search(AFTER_E4, null);
	s.uci.search(AFTER_E4_E5, null);
	same('rushing through positions sends one stop, not one per move', s.drain(), ['stop']);

	s.uci.line('bestmove e2e4');
	same('  ... and searches only the one that was landed on', s.drain(),
		[`position fen ${AFTER_E4_E5}`, 'go infinite']);
}

console.log('\nAn engine that stops answering\n');

{
	const s = session({ stopTimeoutMs: 2_000 });
	s.uci.begin();
	s.handshake();
	s.uci.search(START, null);
	s.drain();

	s.uci.search(AFTER_E4, null);
	same('the position change asks it to stop', s.drain(), ['stop']);

	s.timers.advance(1_999);
	same('a slow engine is given its moment', s.drain(), []);

	s.timers.advance(2);
	same('an engine that never answers `stop` no longer freezes the panel', s.drain(),
		[`position fen ${AFTER_E4}`, 'go infinite']);
	check('  ... and says why', s.warnings.some((w) => w.includes("'stop'")), s.warnings);
}

{
	const s = session({ stopTimeoutMs: 100 });
	s.uci.begin();
	s.handshake();
	s.uci.search(START, null);
	s.uci.search(AFTER_E4, null);
	s.timers.advance(101);
	s.drain();

	s.uci.search(AFTER_E4_E5, null);
	same('the next move after a recovery behaves normally', s.drain(), ['stop']);

	s.uci.line('bestmove e2e4');
	same('  ... the late answer to the abandoned stop changes nothing', s.drain(), []);

	s.uci.line('bestmove e7e5');
	same('  ... and the real answer starts the waiting position', s.drain(),
		[`position fen ${AFTER_E4_E5}`, 'go infinite']);
}

{
	const s = session({ stopTimeoutMs: 100 });
	s.uci.begin();
	s.handshake();
	s.uci.search(START, null);
	s.uci.search(AFTER_E4, null);
	s.timers.advance(101);
	s.drain();

	s.uci.search(AFTER_E4_E5, null);
	s.drain();
	s.uci.line('bestmove e7e5');
	same('an engine that never answers the abandoned stop leaves one swallowed answer', s.drain(), []);

	s.timers.advance(101);
	same('  ... and the watchdog picks the position up regardless', s.drain(),
		[`position fen ${AFTER_E4_E5}`, 'go infinite']);
}

{
	const s = session({ stopTimeoutMs: 100 });
	s.uci.begin();
	s.handshake();
	s.uci.search(START, null);
	s.uci.search(AFTER_E4, null);
	s.timers.advance(101);
	s.drain();

	s.uci.line('bestmove e2e4');
	same('a bestmove arriving late does not restart the position', s.drain(), []);
	check('  ... and does not report the engine as idle', s.idleCount() === 0, s.idleCount());
}

console.log('\nThe search time limit\n');

{
	const s = session();
	s.uci.begin();
	s.handshake();
	s.uci.search(START, 3_000);
	s.drain();

	s.timers.advance(2_999);
	same('the limit is not hit early', s.drain(), []);

	s.timers.advance(2);
	same('a search with a time limit stops itself', s.drain(), ['stop']);

	s.uci.line('bestmove e2e4');
	same('  ... and starts nothing, because nothing is waiting', s.drain(), []);
	check('  ... reporting the engine as idle instead', s.idleCount() === 1, s.idleCount());
}

{
	const s = session();
	s.uci.begin();
	s.handshake();
	s.uci.search(START, 3_000);
	s.uci.search(AFTER_E4, null);
	s.uci.line('bestmove e2e4');
	s.drain();

	s.timers.advance(10_000);
	same('the previous position\'s time limit does not stop the new search', s.drain(), []);
}

{
	const s = session();
	s.uci.begin();
	s.handshake();
	s.uci.search(START, null);
	s.uci.dispose();
	s.drain();

	s.timers.advance(60_000);
	same('a disposed session sends nothing, ever', s.drain(), []);
	check('  ... and leaves no timer behind it', s.timers.pending === 0, s.timers.pending);

	s.uci.line('bestmove e2e4');
	s.uci.search(AFTER_E4, null);
	same('  ... and ignores anything that arrives afterwards', s.drain(), []);
}

console.log();
if (failures.length > 0) {
	console.log(`${failures.length} FAILED: ${JSON.stringify(failures, null, 1)}`);
	process.exit(1);
}
console.log(`${passed} checks passed. The engine cannot be left waiting for something that never comes.`);
