import { computed, signal } from '@angular/core';
import { CaptchaAnswer, CaptchaChallenge, captchaFrom } from './captcha.model';

export class BotCheck {
	private readonly _challenge = signal<CaptchaChallenge | null>(null);
	private readonly _answer = signal<CaptchaAnswer | null>(null);

	readonly challenge = this._challenge.asReadonly();

	readonly verified = computed(() => this._answer() !== null);

	readonly blocked = computed(() => this._challenge() !== null && this._answer() === null);

	adopt(error: unknown): boolean {
		const challenge = captchaFrom(error);
		if (!challenge) {
			return false;
		}
		this._answer.set(null);
		this._challenge.set(challenge);
		return true;
	}

	accept(answer: CaptchaAnswer): void {
		this._answer.set(answer);
	}

	take(): CaptchaAnswer | undefined {
		const answer = this._answer() ?? undefined;
		this._answer.set(null);
		this._challenge.set(null);
		return answer;
	}

	reset(): void {
		this._answer.set(null);
		this._challenge.set(null);
	}
}
