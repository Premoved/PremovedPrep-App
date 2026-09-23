import {
	DestroyRef,
	EnvironmentInjector,
	Injectable,
	computed,
	effect,
	inject,
	signal,
	untracked,
} from '@angular/core';
import { DrawShape } from '@lichess-org/chessground/draw';
import { Key } from '@lichess-org/chessground/types';
import {
	DeviceCapabilities,
	SEARCH_TIME_STEPS,
	maxThreads,
	readDeviceCapabilities,
	recommendedHashMb,
	recommendedThreads,
	shareHashMb,
	shareThreads,
} from '../../../core/engine/engine-capabilities';
import { DEFAULT_ENGINE_ID, EngineDefinition, engineById } from '../../../core/engine/engine-catalogue';
import { EngineTransport, createLocalEngine } from '../../../core/engine/engine-transport';
import { AgentBridgeService } from '../../../core/agent/agent-bridge.service';
import { AgentSelectionStore } from '../../../core/agent/agent-selection.store';
import { LocalEngineCard } from '../../../core/agent/agent.models';
import { EngineConcurrencyStore } from '../../../core/engine/engine-concurrency.store';
import { EngineLoadStore } from '../../../core/engine/engine-load.store';
import { EngineLine, parseInfoLine, parseUciMove } from '../../../core/engine/uci';
import { UciSession } from '../../../core/engine/uci-session';
import { GamePreviewStore } from './game-preview.store';
import { MoveTreeStore } from './move-tree.store';

export interface EngineSettings {
	readonly searchSeconds: number;
	readonly multiPv: number;
	readonly threads: number;
	readonly hashMb: number;
}

export type EngineStatus = 'off' | 'loading' | 'ready' | 'searching' | 'failed';

const ARROW_WIDTHS = [13, 10, 8, 6, 5];

@Injectable()
export class EngineStore {
	private readonly tree = inject(MoveTreeStore);
	private readonly preview = inject(GamePreviewStore);

	private readonly bridge = inject(AgentBridgeService);
	private readonly agentSelection = inject(AgentSelectionStore);
	private readonly destroyRef = inject(DestroyRef);
	private readonly load = inject(EngineLoadStore);
	private readonly concurrency = inject(EngineConcurrencyStore);

	// Effects below run against this, not the default injector: a view effect stops when its
	// tab is a detached (off-screen) view, which would silently pause the engine process.
	private readonly environment = inject(EnvironmentInjector);

	private readonly _localEngineId = signal<number | null>(null);

	private settled = false;

	private readonly boardTree = computed(() => this.preview.tree() ?? this.tree);

	readonly positionFen = computed(() => this.boardTree().currentNode().fen);

	private readonly solutionHidden = computed(() => this.boardTree().solutionHiddenAtCurrent());

	readonly capabilities: DeviceCapabilities = readDeviceCapabilities();

	private readonly _enabled = signal(false);

	private readonly _running = signal(false);

	private readonly _hidden = signal(false);
	private readonly _definition = signal<EngineDefinition>(engineById(DEFAULT_ENGINE_ID));
	private readonly _status = signal<EngineStatus>('off');
	private readonly _error = signal<string | null>(null);
	private readonly _lines = signal<readonly EngineLine[]>([]);
	private readonly _depth = signal(0);
	private readonly _nps = signal(0);

	private readonly _hoveredLine = signal<number | null>(null);

	private readonly _arrowsVisible = signal(false);

	private readonly _settings = signal<EngineSettings>(this.defaultSettings(engineById(DEFAULT_ENGINE_ID)));

	readonly enabled = this._enabled.asReadonly();
	readonly definition = this._definition.asReadonly();
	readonly status = this._status.asReadonly();
	readonly error = this._error.asReadonly();
	readonly settings = this._settings.asReadonly();
	readonly depth = this._depth.asReadonly();
	readonly nps = this._nps.asReadonly();

	readonly lines = computed(() => [...this._lines()].sort((a, b) => a.multipv - b.multipv));

	readonly best = computed<EngineLine | null>(() => this.lines()[0] ?? null);

	readonly arrowsVisible = this._arrowsVisible.asReadonly();

	readonly boardShapes = computed<DrawShape[]>(() => {
		const hovered = this._hoveredLine();
		const lines = this.lines();

		if (!this._arrowsVisible()) {
			const one = lines.find((line) => line.multipv === hovered);
			return one ? [arrowFor(one, 0)] : [];
		}

		return lines.map((line, rank) => arrowFor(line, line.multipv === hovered ? 0 : rank));
	});

	private readonly localCard = computed<LocalEngineCard | null>(() => {
		const id = this._localEngineId();
		if (id === null || !this.bridge.connected()) {
			return null;
		}
		return this.bridge.engines().find((card) => card.id === id) ?? null;
	});

	// Counts itself even before starting: the thread/hash advice must be right before enabling.
	private readonly boards = computed(() => this.load.running() + (this._running() ? 0 : 1));

	readonly maxThreads = computed(() => {
		const local = this.localEngine();
		if (local) {
			return local.threads ? Math.max(1, local.maxThreads ?? this.capabilities.cores) : 1;
		}
		return maxThreads(this.capabilities, this._definition());
	});

	readonly recommendedThreads = computed(() => {
		const local = this.localEngine();
		const alone = local
			? local.threads
				? Math.max(1, Math.min(this.maxThreads(), this.capabilities.cores - 1))
				: 1
			: recommendedThreads(this.capabilities, this._definition());
		return shareThreads(alone, this.boards());
	});

	readonly recommendedHashMb = computed(() =>
		shareHashMb(recommendedHashMb(this.capabilities, this._definition()), this.boards()),
	);

	readonly localEngine = computed(() => (this._definition().kind === 'local' ? this.localCard() : null));

	readonly displayName = computed(
		() => this.localEngine()?.reportedName ?? this.localEngine()?.name ?? this._definition().shortLabel,
	);

	private transport: EngineTransport | null = null;
	private loadedKey = '';

	private release: (() => void) | null = null;

	private session: UciSession | null = null;

	constructor() {
		// Adopts the default engine once; a board already settled on one is never overruled
		// by the default changing later.
		const adoption = effect(
			() => {
				const fallback = this.agentSelection.defaultEngine();
				const mine = this.localCard();
				untracked(() => {
					if (!fallback) {
						return;
					}
					if (this.settled && (mine !== null || this._definition().kind !== 'local')) {
						return;
					}
					this.settled = true;
					this._localEngineId.set(fallback.id);
					this.useDefinition(engineById('local'));
				});
			},
			{ injector: this.environment },
		);

		const run = effect(
			() => {
				// Read first and alone: with the engine off, nothing else is a reason to react,
				// and tracking the position would rebuild this effect on every move.
				if (!this._enabled()) {
					untracked(() => this.shutDown());
					return;
				}

				// Hidden tab, and this machine analyses one board at a time.
				if (this._hidden() && !this.concurrency.enabled()) {
					untracked(() => this.shutDown());
					return;
				}

				const definition = this._definition();
				const settings = this._settings();
				const fen = this.positionFen();
				const card = this.localCard();

				this.start(definition, settings, fen, card);
			},
			{ injector: this.environment },
		);

		// Root effects outlive the component; without this a closed board's engine keeps running.
		this.destroyRef.onDestroy(() => {
			adoption.destroy();
			run.destroy();
			this.shutDown();
		});
	}

	setEnabled(enabled: boolean): void {
		// The hidden solution must never reach the engine, whichever caller asks to enable it.
		if (enabled && this.solutionHidden()) return;
		this._enabled.set(enabled);
	}

	// Leaves the enabled switch alone; only pauses the process while the tab is off screen.
	setHidden(hidden: boolean): void {
		this._hidden.set(hidden);
	}

	selectEngine(id: string, localEngineId: number | null = null): void {
		this.settled = true;
		const definition = engineById(id);
		const wanted = definition.kind === 'local' ? localEngineId : null;
		if (definition.id === this._definition().id && wanted === this._localEngineId()) return;
		this._localEngineId.set(wanted);
		this.useDefinition(definition);
	}

	private useDefinition(definition: EngineDefinition): void {
		this._definition.set(definition);
		this._settings.set({
			...this.defaultSettings(definition),
			threads: this.recommendedThreads(),
			hashMb: this.recommendedHashMb(),
		});
	}

	setHoveredLine(multipv: number | null): void {
		this._hoveredLine.set(multipv);
	}

	toggleArrows(): void {
		this._arrowsVisible.update((on) => !on);
	}

	updateSettings(patch: Partial<EngineSettings>): void {
		this._settings.update((current) => ({ ...current, ...patch }));
	}

	private defaultSettings(definition: EngineDefinition): EngineSettings {
		return {
			searchSeconds: Infinity,
			multiPv: 2,
			threads: recommendedThreads(this.capabilities, definition),
			hashMb: recommendedHashMb(this.capabilities, definition),
		};
	}

	private start(
		definition: EngineDefinition,
		settings: EngineSettings,
		fen: string,
		card: LocalEngineCard | null,
	): void {
		if (this.transport && this.loadedKey === this.keyFor(definition, settings)) {
			// Same search already running: the effect re-runs (e.g. tab visibility) and must not restart it.
			if (this.searching === this.requestFor(fen, settings)) {
				return;
			}
			this.search(fen);
			return;
		}

		this.shutDown();

		this._status.set('loading');
		this._error.set(null);
		this.loadedKey = this.keyFor(definition, settings);

		const onError = (message: string) => {
			this._status.set('failed');
			this._error.set(this.withEngineOutput(message));
		};

		// Only reachable while the adoption effect is still re-selecting a default;
		// it resolves again on the next tick once the card arrives.
		if (!card) {
			this.shutDown();
			return;
		}
		this.transport = createLocalEngine(this.bridge, card.id, (line) => this.onLine(line), onError);

		this.release = this.load.claim();
		this._running.set(true);

		const setOptions: string[] = [];
		if (definition.threads) setOptions.push(`name Threads value ${settings.threads}`);
		setOptions.push(`name Hash value ${settings.hashMb}`);
		setOptions.push(`name MultiPV value ${settings.multiPv}`);

		this.session = new UciSession(
			{
				send: (command) => this.transport?.send(command),
				onIdle: () => this._status.set('ready'),
				onWarning: (message) => this.onEngineWarning(message),
			},
			{ setOptions },
		);
		this.session.begin();
		this.search(fen);
	}

	private onEngineWarning(message: string): void {
		this.recentOutput.push(`[engine] ${message}`);
		if (this.recentOutput.length > 12) this.recentOutput.shift();
		console.warn(`[engine] ${message}`);
	}

	private searching: string | null = null;

	private requestFor(fen: string, settings: EngineSettings): string {
		return `${fen}|${settings.searchSeconds}`;
	}

	private keyFor(definition: EngineDefinition, settings: EngineSettings): string {
		const local = definition.kind === 'local' ? (this._localEngineId() ?? 'none') : '';
		return [definition.id, local, settings.threads, settings.hashMb, settings.multiPv].join('|');
	}

	private search(fen: string): void {
		if (!this.session) return;

		this.searching = this.requestFor(fen, this._settings());
		this._lines.set([]);
		this._depth.set(0);
		this._status.set('searching');

		// Infinity is a legal setting: search until something else stops it.
		const seconds = this._settings().searchSeconds;
		this.session.search(fen, Number.isFinite(seconds) ? seconds * 1000 : null);
	}

	private readonly recentOutput: string[] = [];

	private withEngineOutput(message: string): string {
		const tail = this.recentOutput.filter((line) => line.trim().length > 0).slice(-3);
		return tail.length > 0 ? `${message}\n${tail.join('\n')}` : message;
	}

	private onLine(line: string): void {
		this.recentOutput.push(line);
		if (this.recentOutput.length > 12) this.recentOutput.shift();

		this.session?.line(line);

		if (!this.session?.acceptsInfo) return;

		const parsed = parseInfoLine(line);
		if (!parsed) return;

		this._depth.set(parsed.depth);
		if (parsed.nps > 0) this._nps.set(parsed.nps);

		this._lines.update((lines) => {
			const next = lines.filter((existing) => existing.multipv !== parsed.multipv);
			next.push(parsed);
			return next;
		});
	}

	private shutDown(): void {
		this.searching = null;
		this.release?.();
		this.release = null;
		this._running.set(false);
		this.session?.dispose();
		this.session = null;
		this.transport?.dispose();
		this.transport = null;
		this.loadedKey = '';
		this._lines.set([]);
		this._depth.set(0);
		this._nps.set(0);
		this._status.set('off');
		this._error.set(null);
	}

	readonly searchTimeSteps = SEARCH_TIME_STEPS;
}

function arrowFor(line: EngineLine, rank: number): DrawShape {
	const move = parseUciMove(line.pv[0] ?? '');
	return {
		orig: (move?.from ?? 'a1') as Key,
		dest: (move?.to ?? 'a1') as Key,
		// A brush of the engine's own, registered in ChessBoardComponent.
		brush: 'engine',
		modifiers: { lineWidth: ARROW_WIDTHS[Math.min(rank, ARROW_WIDTHS.length - 1)] },
	};
}
