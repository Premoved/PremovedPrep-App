import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from './auth.service';
import { DesktopAppApiService } from './desktop-app.service';
import { DesktopAppAccess } from '../models/user.model';
import { isOffline } from '../browser/offline';

export type PlanLock = 'signed-out' | 'checking' | 'plan' | 'preview' | 'unverified';

const REMEMBERED_KEY = 'premovedprep.planAccess';

const RECHECK_MS = 10 * 60_000;

interface Remembered {
	readonly userId: number;
	readonly access: DesktopAppAccess;
}

/** Decided by the server via /api/app/access; this app's source is public, so a self-check is not trustworthy. */
@Injectable({ providedIn: 'root' })
export class PlanAccessService {
	private readonly auth = inject(AuthService);
	private readonly api = inject(DesktopAppApiService);

	private readonly answer = signal<DesktopAppAccess | null>(null);
	private readonly reached = signal(false);
	// Honoured only while offline, so a session that cannot renew still opens the tools it had before.
	private readonly kept = signal<DesktopAppAccess | null>(recall()?.access ?? null);
	// Only the latest question is listened to: a sign-out while one is in flight must win.
	private asked = 0;
	private lastUserId: number | null = null;

	readonly access = this.answer.asReadonly();

	readonly lock = computed<PlanLock | null>(() => {
		if (!this.auth.isLoggedIn()) {
			const kept = this.kept();
			if (kept !== null && !this.reached()) {
				return refusal(kept);
			}
			return 'signed-out';
		}
		const answer = this.answer();
		return answer === null ? null : refusal(answer);
	});

	constructor() {
		effect(() => {
			const userId = this.auth.currentUser()?.id ?? null;
			untracked(() => this.follow(userId));
		});

		if (typeof window !== 'undefined') {
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') {
					this.check();
				}
			});
			window.addEventListener('online', () => this.check());
			window.addEventListener('offline', () => this.reached.set(false));
			setInterval(() => this.check(), RECHECK_MS);
		}
	}

	refresh(): void {
		this.check();
	}

	private follow(userId: number | null): void {
		const previous = this.lastUserId;
		this.lastUserId = userId;

		if (userId === null && previous !== null) {
			forget();
			this.kept.set(null);
		}
		if (userId !== null && previous !== userId) {
			const remembered = recall();
			this.answer.set(remembered?.userId === userId ? remembered.access : null);
		}
		this.check();
	}

	private check(): void {
		const ticket = ++this.asked;
		const userId = this.auth.currentUser()?.id ?? null;

		if (userId === null) {
			this.answer.set(null);
			if (this.kept() !== null) {
				this.probe(ticket);
			}
			return;
		}

		this.api.access().subscribe({
			next: (access) => {
				if (ticket !== this.asked) return;
				this.reached.set(true);
				this.answer.set(access);
				this.kept.set(access);
				remember({ userId, access });
			},
			error: (error: unknown) => {
				if (ticket !== this.asked) return;
				if (isOffline(error)) this.reached.set(false);
			},
		});
	}

	// Tells apart "server unreachable" from "really signed out" via the public stage endpoint.
	private probe(ticket: number): void {
		this.api.stage().subscribe({
			next: async () => {
				if (ticket !== this.asked || this.auth.isLoggedIn()) return;
				await this.auth.restoreSession();
				if (ticket !== this.asked || this.auth.isLoggedIn()) return;
				this.reached.set(true);
				forget();
				this.kept.set(null);
			},
			error: (error: unknown) => {
				if (ticket !== this.asked) return;
				if (isOffline(error)) this.reached.set(false);
			},
		});
	}
}

function refusal(access: DesktopAppAccess): PlanLock | null {
	if (access.allowed) {
		return null;
	}
	return access.reason === 'PREVIEW' ? 'preview' : 'plan';
}

function recall(): Remembered | null {
	try {
		const raw = localStorage.getItem(REMEMBERED_KEY);
		return raw ? (JSON.parse(raw) as Remembered) : null;
	} catch {
		return null;
	}
}

function remember(value: Remembered): void {
	try {
		localStorage.setItem(REMEMBERED_KEY, JSON.stringify(value));
	} catch {
		// Storage unavailable: offline start shows the sign-in notice.
	}
}

function forget(): void {
	try {
		localStorage.removeItem(REMEMBERED_KEY);
	} catch {
		// Storage unavailable: nothing to forget.
	}
}
