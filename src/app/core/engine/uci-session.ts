// The UCI conversation as a state machine: handshake, options, search, stop, and the timeouts around each.
export interface Timers {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export const REAL_TIMERS: Timers = {
	set: (run, ms) => setTimeout(run, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface UciSessionCallbacks {
	send(command: string): void;

	onIdle?(): void;

	onWarning?(message: string): void;
}

export interface UciSessionOptions {
	readonly setOptions: readonly string[];

	/** How long to wait for uciok and then readyok before searching anyway. */
	readonly readyTimeoutMs?: number;

	readonly stopTimeoutMs?: number;

	readonly timers?: Timers;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;

const DEFAULT_STOP_TIMEOUT_MS = 2_000;

type Phase = 'new' | 'uci' | 'options' | 'ready' | 'closed';

export class UciSession {
	private phase: Phase = 'new';

	private pendingFen: string | null = null;

	private pendingLimitMs: number | null = null;

	private awaitingBestMove = false;

	private stopRequested = false;

	// bestmove replies belonging to searches this session has already abandoned.
	private strayBestMoves = 0;

	private readyTimer: unknown = null;
	private stopTimer: unknown = null;
	private searchTimer: unknown = null;

	private readonly timers: Timers;
	private readonly readyTimeoutMs: number;
	private readonly stopTimeoutMs: number;

	constructor(
		private readonly callbacks: UciSessionCallbacks,
		private readonly options: UciSessionOptions,
	) {
		this.timers = options.timers ?? REAL_TIMERS;
		this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
	}

	get acceptsInfo(): boolean {
		return this.awaitingBestMove && this.pendingFen === null;
	}

	begin(): void {
		if (this.phase !== 'new') {
			return;
		}
		this.phase = 'uci';
		this.callbacks.send('uci');
		this.readyTimer = this.timers.set(() => this.giveUpWaitingForReady(), this.readyTimeoutMs);
	}

	search(fen: string, limitMs: number | null): void {
		if (this.phase === 'closed') {
			return;
		}

		this.timers.clear(this.searchTimer);
		this.searchTimer = null;
		this.pendingFen = fen;
		this.pendingLimitMs = limitMs;

		if (this.phase !== 'ready') {
			return;
		}

		if (this.awaitingBestMove) {
			// The previous search has to end before the next can start, and stop is how it is asked.
			if (!this.stopRequested) {
				this.stopRequested = true;
				this.callbacks.send('stop');
				this.stopTimer = this.timers.set(() => this.giveUpWaitingForBestMove(), this.stopTimeoutMs);
			}
			return;
		}

		this.beginPending();
	}

	line(text: string): void {
		if (this.phase === 'closed') {
			return;
		}
		const token = text.trim().split(/\s+/, 1)[0];

		if (token === 'uciok') {
			this.onUciOk();
			return;
		}
		if (token === 'readyok') {
			this.onReadyOk();
			return;
		}
		if (token === 'bestmove') {
			this.onBestMove();
		}
	}

	dispose(): void {
		this.phase = 'closed';
		this.pendingFen = null;
		this.awaitingBestMove = false;
		this.stopRequested = false;
		this.strayBestMoves = 0;
		this.timers.clear(this.readyTimer);
		this.timers.clear(this.stopTimer);
		this.timers.clear(this.searchTimer);
		this.readyTimer = null;
		this.stopTimer = null;
		this.searchTimer = null;
	}

	private onUciOk(): void {
		if (this.phase !== 'uci') {
			return;
		}
		this.phase = 'options';
		for (const option of this.options.setOptions) {
			this.callbacks.send(`setoption ${option}`);
		}
		this.callbacks.send('isready');
	}

	private onReadyOk(): void {
		if (this.phase === 'ready' || this.phase === 'closed') {
			return;
		}
		this.becomeReady();
	}

	private becomeReady(): void {
		this.phase = 'ready';
		this.timers.clear(this.readyTimer);
		this.readyTimer = null;
		if (this.pendingFen !== null && !this.awaitingBestMove) {
			this.beginPending();
		}
	}

	private giveUpWaitingForReady(): void {
		if (this.phase === 'ready' || this.phase === 'closed') {
			return;
		}
		this.callbacks.onWarning?.(
			`The engine did not answer the UCI handshake within ${this.readyTimeoutMs / 1000}s` +
				` (waiting for ${this.phase === 'uci' ? 'uciok' : 'readyok'}). Searching anyway.`,
		);
		this.becomeReady();
	}

	private beginPending(): void {
		const fen = this.pendingFen;
		if (fen === null) {
			return;
		}

		this.timers.clear(this.stopTimer);
		this.stopTimer = null;
		this.stopRequested = false;

		const limitMs = this.pendingLimitMs;
		this.pendingFen = null;
		this.pendingLimitMs = null;
		this.awaitingBestMove = true;

		this.callbacks.send(`position fen ${fen}`);
		this.callbacks.send('go infinite');

		if (limitMs !== null && Number.isFinite(limitMs)) {
			this.searchTimer = this.timers.set(() => {
				this.searchTimer = null;
				if (this.awaitingBestMove && !this.stopRequested) {
					this.stopRequested = true;
					this.callbacks.send('stop');
				}
			}, limitMs);
		}
	}

	private onBestMove(): void {
		if (this.strayBestMoves > 0) {
			this.strayBestMoves--;
			return;
		}

		this.awaitingBestMove = false;
		this.stopRequested = false;
		this.timers.clear(this.stopTimer);
		this.stopTimer = null;

		if (this.pendingFen !== null) {
			this.beginPending();
			return;
		}
		this.timers.clear(this.searchTimer);
		this.searchTimer = null;
		this.callbacks.onIdle?.();
	}

	private giveUpWaitingForBestMove(): void {
		this.stopTimer = null;
		if (!this.awaitingBestMove || this.phase === 'closed') {
			return;
		}
		this.callbacks.onWarning?.(
			`The engine did not answer 'stop' within ${this.stopTimeoutMs / 1000}s.` +
				' Starting the next position without waiting for it.',
		);
		this.awaitingBestMove = false;
		this.stopRequested = false;
		this.strayBestMoves++;
		if (this.pendingFen !== null) {
			this.beginPending();
			return;
		}
		this.timers.clear(this.searchTimer);
		this.searchTimer = null;
		this.callbacks.onIdle?.();
	}
}
