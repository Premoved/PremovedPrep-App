import { ApiError } from '../interceptors/error.interceptor';

export interface CaptchaChallenge {
	readonly id: string;
	/** Black to move, always. */
	readonly fen: string;
	readonly blackMove: string;
	readonly expiresInSeconds: number;
}

export interface CaptchaAnswer {
	readonly id: string;
	readonly move: string;
	/** Trusted pointer or touch events counted before the answer. */
	readonly interactions: number;
}

export function captchaFrom(error: unknown): CaptchaChallenge | null {
	if (!(error instanceof ApiError) || error.status !== 428) {
		return null;
	}
	const challenge = error.problem?.['captcha'];
	if (challenge === null || typeof challenge !== 'object') {
		return null;
	}

	const candidate = challenge as Record<string, unknown>;
	const id = candidate['id'];
	const fen = candidate['fen'];
	const blackMove = candidate['blackMove'];
	const expiresInSeconds = candidate['expiresInSeconds'];

	if (typeof id !== 'string' || id.length === 0) return null;
	if (typeof fen !== 'string' || fen.length === 0) return null;
	if (typeof blackMove !== 'string' || blackMove.length < 4) return null;

	return {
		id,
		fen,
		blackMove,
		expiresInSeconds: typeof expiresInSeconds === 'number' ? expiresInSeconds : 300,
	};
}
