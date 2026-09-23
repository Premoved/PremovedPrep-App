import { Injectable, signal } from '@angular/core';

// Three answers because two are not always enough: a "Save changes?" dismiss is neither save nor discard.
export type ConfirmAnswer = 'confirm' | 'cancel' | 'dismiss';

export interface ConfirmRequest {
	readonly message: string;
	readonly confirmLabel: string;
	readonly cancelLabel: string;
	readonly danger: boolean;
	/** Whether the corner cross is offered. Only questions with a harmless third answer show one. */
	readonly dismissible: boolean;
	readonly resolve: (value: ConfirmAnswer) => void;
}

export interface ConfirmOptions {
	readonly confirmLabel?: string;
	readonly cancelLabel?: string;
	readonly danger?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
	readonly request = signal<ConfirmRequest | null>(null);

	ask(message: string, options: ConfirmOptions = {}): Promise<boolean> {
		return this.put(message, options, false).then((answer) => answer === 'confirm');
	}

	askOrDismiss(message: string, options: ConfirmOptions = {}): Promise<ConfirmAnswer> {
		return this.put(message, options, true);
	}

	answer(value: ConfirmAnswer): void {
		this.request()?.resolve(value);
		this.request.set(null);
	}

	private put(message: string, options: ConfirmOptions, dismissible: boolean): Promise<ConfirmAnswer> {
		// A second question while one is open dismisses the first: it answers nothing on its behalf.
		this.request()?.resolve('dismiss');

		return new Promise<ConfirmAnswer>((resolve) => {
			this.request.set({
				message,
				confirmLabel: options.confirmLabel ?? 'OK',
				cancelLabel: options.cancelLabel ?? 'Cancel',
				danger: options.danger ?? false,
				dismissible,
				resolve,
			});
		});
	}
}
