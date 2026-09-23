import { Injectable, signal } from '@angular/core';
import { LAST_RESORT, SIGN_IN_REQUIRED } from '../interceptors/error.interceptor';

export type NoticeKind = 'error' | 'info';

export interface NoticeAction {
	readonly label: string;
	readonly href: string;
}

export interface Notice {
	readonly id: number;
	readonly kind: NoticeKind;
	readonly message: string;
	readonly action?: NoticeAction;
}

const SIGN_IN: NoticeAction = { label: 'Sign in', href: '/login' };

const ERROR_MS = 9000;
const INFO_MS = 4500;

@Injectable({ providedIn: 'root' })
export class NotificationService {
	private nextId = 1;
	private readonly items = signal<readonly Notice[]>([]);
	private readonly stickyIds = new Map<string, number>();
	private readonly dismissedSticky = new Map<string, string>();

	readonly notices = this.items.asReadonly();

	error(message: string): void {
		this.push('error', message, ERROR_MS);
	}

	info(message: string): void {
		this.push('info', message, INFO_MS);
	}

	/** Keyed so a repeat call replaces rather than stacks. Dismissed, it stays away unless `insist`. */
	sticky(key: string, kind: NoticeKind, message: string, action?: NoticeAction, insist = false): void {
		const existing = this.stickyIds.get(key);
		const current = existing === undefined ? undefined : this.items().find((notice) => notice.id === existing);
		if (current && current.message === message && current.kind === kind) {
			return;
		}
		if (existing !== undefined) {
			this.stickyIds.delete(key);
			this.items.update((list) => list.filter((notice) => notice.id !== existing));
		}
		if (!insist && this.dismissedSticky.get(key) === message) {
			return;
		}
		const id = this.nextId++;
		this.stickyIds.set(key, id);
		this.items.update((list) => [...list, { id, kind, message, action }]);
	}

	dismiss(id: number): void {
		for (const [key, stickyId] of this.stickyIds) {
			if (stickyId === id) {
				const notice = this.items().find((item) => item.id === id);
				if (notice) {
					this.dismissedSticky.set(key, notice.message);
				}
				this.stickyIds.delete(key);
			}
		}
		this.items.update((list) => list.filter((notice) => notice.id !== id));
	}

	private push(kind: NoticeKind, message: string, timeoutMs: number): void {
		const text = message?.trim() ? message.trim() : LAST_RESORT;
		if (this.items().some((notice) => notice.kind === kind && notice.message === text)) {
			return;
		}

		const id = this.nextId++;
		// Matched on text rather than passed by each of the dozens of 401 call sites.
		const action = text === SIGN_IN_REQUIRED ? SIGN_IN : undefined;
		this.items.update((list) => [...list, { id, kind, message: text, action }]);

		// No NgZone: the app is zoneless, so the signal write above is what schedules the re-render.
		setTimeout(() => this.dismiss(id), timeoutMs);
	}
}
