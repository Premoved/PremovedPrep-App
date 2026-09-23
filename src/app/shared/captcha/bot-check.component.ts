import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	OnDestroy,
	computed,
	effect,
	inject,
	input,
	output,
	signal,
	untracked,
	viewChild,
} from '@angular/core';
import { Chessground } from '@lichess-org/chessground';
import { Api } from '@lichess-org/chessground/api';
import { DrawShape } from '@lichess-org/chessground/draw';
import { Key } from '@lichess-org/chessground/types';
import { CaptchaAnswer, CaptchaChallenge } from '../../core/captcha/captcha.model';
import { afterMove, anyMove, isMateIn, mateIn, playBlack, sanOf } from '../../core/captcha/premove-mate';
import { arrowBrushes } from '../../core/models/preferences.model';
import { PreferencesStore } from '../../core/services/preferences.store';

const MOVE_ANIMATION_MS = 200;

const THINKING_MS = 850;

const REPLY_DELAY_MS = 450;

type Phase = 'waiting' | 'thinking' | 'solved' | 'failed';

@Component({
	selector: 'app-bot-check',
	standalone: true,
	templateUrl: './bot-check.component.html',
	styleUrl: './bot-check.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BotCheckComponent implements AfterViewInit, OnDestroy {
	private readonly prefs = inject(PreferencesStore);
	private readonly host = viewChild<ElementRef<HTMLElement>>('host');

	readonly challenge = input.required<CaptchaChallenge>();

	readonly solved = output<CaptchaAnswer>();

	readonly moveDests = computed(() => this.prefs.moveDests());

	readonly phase = signal<Phase>('waiting');

	readonly hint = signal<string | null>(null);
	readonly hintShown = signal(false);

	private api?: Api;
	private readonly timers: ReturnType<typeof setTimeout>[] = [];

	private interactions = 0;

	private hintMove: string | null = null;

	private drawnId: string | null = null;

	constructor() {
		effect(() => {
			const challenge = this.challenge();
			const coordinates = this.prefs.coordinates();
			const colours = this.prefs.arrowColors();
			this.prefs.pieceSet();
			this.prefs.boardThemeId();

			untracked(() => this.build(challenge, coordinates, colours));
		});
	}

	ngAfterViewInit(): void {
		if (!this.api) {
			this.build(this.challenge(), this.prefs.coordinates(), this.prefs.arrowColors());
		}
	}

	ngOnDestroy(): void {
		this.clearTimers();
		this.api?.destroy();
	}

	tryAgain(): void {
		this.phase.set('waiting');
		this.build(this.challenge(), this.prefs.coordinates(), this.prefs.arrowColors());
	}

	// isTrusted excludes synthetic/dispatched events, so a scripted solver can't fake interaction.
	onInteraction(event: Event): void {
		if (event.isTrusted) {
			this.interactions++;
		}
	}

	revealHint(): void {
		if (this.hintMove === null) {
			const challenge = this.challenge();
			const after = playBlack(challenge.fen, challenge.blackMove);
			const solution = after ? mateIn(after.fen) : null;
			this.hintMove = solution;
			this.hint.set(after && solution ? sanOf(after.fen, solution) : null);
		}
		this.hintShown.set(true);
		this.api?.setAutoShapes(this.hintShapes());
	}

	private build(challenge: CaptchaChallenge, coordinates: boolean, colours: readonly string[]): void {
		const element = this.host()?.nativeElement;
		if (!element) {
			return;
		}

		if (this.drawnId !== challenge.id) {
			this.drawnId = challenge.id;
			this.hint.set(null);
			this.hintShown.set(false);
			this.hintMove = null;
			this.phase.set('waiting');
			this.interactions = 0;
		}
		this.clearTimers();

		this.api?.destroy();
		element.innerHTML = '';
		this.api = Chessground(element, this.options(challenge, coordinates, colours));
	}

	private options(challenge: CaptchaChallenge, coordinates: boolean, colours: readonly string[]) {
		return {
			fen: challenge.fen,
			orientation: 'white' as const,
			turnColor: 'black' as const,
			coordinates,
			autoCastle: false,
			// 0, not the default 1: at 1, chessground cancels touchstart (and the page scroll with it)
			// near any piece, which on a phone is most of the board.
			touchIgnoreRadius: 0,
			movable: { free: false, color: 'white' as const, showDests: true, dests: new Map<Key, Key[]>() },
			premovable: {
				enabled: true,
				showDests: true,
				events: { set: (orig: Key, dest: Key) => this.onPremove(orig, dest) },
			},
			draggable: { enabled: true },
			selectable: { enabled: true },
			drawable: {
				enabled: false, // not editable
				visible: true, // renders the SVG layer the hint arrow needs
				brushes: arrowBrushes(colours),
				autoShapes: this.hintShapes(),
			},
			animation: { enabled: true, duration: MOVE_ANIMATION_MS },
		};
	}

	private hintShapes(): DrawShape[] {
		if (!this.hintShown() || this.hintMove === null) {
			return [];
		}
		return [{ orig: this.hintMove.slice(0, 2) as Key, dest: this.hintMove.slice(2, 4) as Key, brush: 'green' }];
	}

	private onPremove(orig: Key, dest: Key): void {
		if (this.phase() !== 'waiting') {
			return;
		}
		this.phase.set('thinking');

		const challenge = this.challenge();
		const after = playBlack(challenge.fen, challenge.blackMove);
		const api = this.api;
		if (!after || !api) {
			this.phase.set('failed');
			return;
		}

		api.set({ premovable: { enabled: false }, draggable: { enabled: false }, selectable: { enabled: false } });

		this.after(THINKING_MS, () => {
			api.move(challenge.blackMove.slice(0, 2) as Key, challenge.blackMove.slice(2, 4) as Key);

			// Gives black's move one frame to start rendering before the queued premove fires.
			requestAnimationFrame(() => {
				api.set({
					turnColor: 'white',
					movable: { color: 'white', dests: after.dests },
					animation: { enabled: false },
				});
				const played = api.playPremove();
				api.set({ animation: { enabled: true } });

				if (!played) {
					// chessground discarded it as illegal.
					this.phase.set('failed');
					return;
				}

				const answer = orig + dest;
				if (isMateIn(after.fen, answer)) {
					this.phase.set('solved');
					api.set({ movable: { color: undefined }, premovable: { enabled: false } });
					this.solved.emit({ id: challenge.id, move: answer, interactions: this.interactions });
					return;
				}

				this.answerTheFailedAttempt(api, after.fen, answer);
			});
		});
	}

	private answerTheFailedAttempt(api: Api, beforeWhite: string, whiteMove: string): void {
		const afterWhite = afterMove(beforeWhite, whiteMove);
		const reply = afterWhite ? anyMove(afterWhite) : null;
		if (!reply) {
			this.phase.set('failed');
			return;
		}

		this.after(REPLY_DELAY_MS, () => {
			api.set({ turnColor: 'black' });
			api.move(reply.slice(0, 2) as Key, reply.slice(2, 4) as Key);
			this.after(MOVE_ANIMATION_MS, () => this.phase.set('failed'));
		});
	}

	private after(delay: number, run: () => void): void {
		this.timers.push(setTimeout(run, delay));
	}

	private clearTimers(): void {
		this.timers.forEach((timer) => clearTimeout(timer));
		this.timers.length = 0;
	}
}
