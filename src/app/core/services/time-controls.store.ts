import { Injectable, computed, inject, signal } from '@angular/core';
import { FIDE_TIME_CONTROLS } from '../chess/time-control';
import { AuthService } from './auth.service';
import { TimeControlApiService } from './time-control-api.service';

const STORAGE_KEY = 'premovedprep.timeControls';

// The ones saved here while the account could not be reached, with the account they belong to:
// sent to it once it can be.
const UNSYNCED_KEY = 'premovedprep.timeControls.unsynced';

interface Unsynced {
	readonly userId: number;
	readonly values: readonly string[];
}

/**
 * The time controls the user has typed in Custom… and kept: on this device always, and on the
 * account as well when signed in, so they are there offline and signed out too. Each one is kept
 * as written ("40 min + 20 sec"); its TimeControl is read from it when it is chosen.
 */
@Injectable({ providedIn: 'root' })
export class TimeControlsStore {
	private readonly api = inject(TimeControlApiService);
	private readonly auth = inject(AuthService);

	private readonly local = signal<readonly string[]>(readLocal());
	private readonly account = signal<readonly string[]>([]);

	constructor() {
		window.addEventListener('online', () => this.refresh());
	}

	readonly mine = computed<readonly string[]>(() => {
		const presets = new Set(FIDE_TIME_CONTROLS.map((preset) => preset.name));
		return [...new Set([...this.local(), ...this.account()])].filter((name) => !presets.has(name));
	});

	refresh(): void {
		if (!this.auth.isLoggedIn()) {
			this.account.set([]);
			return;
		}
		this.api.list().subscribe({
			next: (list) => {
				this.account.set(list.map((entry) => entry.value));
				this.sendUnsynced();
			},
			error: () => undefined,
		});
	}

	private sendUnsynced(): void {
		const user = this.auth.currentUser();
		const pending = readUnsynced();
		if (!user || !pending || pending.userId !== user.id) {
			return;
		}
		for (const value of pending.values) {
			if (this.account().includes(value)) {
				dropUnsynced(value);
				continue;
			}
			this.create(user.id, value);
		}
	}

	private create(userId: number, value: string): void {
		this.api.create(value).subscribe({
			next: () => {
				dropUnsynced(value);
				this.account.update((list) => (list.includes(value) ? list : [...list, value]));
			},
			error: () => addUnsynced(userId, value),
		});
	}

	save(name: string): void {
		const value = name.trim();
		if (value.length === 0 || FIDE_TIME_CONTROLS.some((preset) => preset.name === value)) {
			return;
		}
		if (!this.local().includes(value)) {
			this.local.update((list) => [...list, value]);
			writeLocal(this.local());
		}
		const user = this.auth.currentUser();
		if (this.auth.isLoggedIn() && user && !this.account().includes(value)) {
			this.create(user.id, value);
		}
	}
}

function readLocal(): readonly string[] {
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
		return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string') : [];
	} catch {
		return [];
	}
}

function readUnsynced(): Unsynced | null {
	try {
		const stored = JSON.parse(localStorage.getItem(UNSYNCED_KEY) ?? 'null') as Unsynced | null;
		return stored && typeof stored.userId === 'number' && Array.isArray(stored.values) ? stored : null;
	} catch {
		return null;
	}
}

function addUnsynced(userId: number, value: string): void {
	const current = readUnsynced();
	const values = current && current.userId === userId ? current.values : [];
	if (!values.includes(value)) {
		writeUnsynced({ userId, values: [...values, value] });
	}
}

function dropUnsynced(value: string): void {
	const current = readUnsynced();
	if (current) {
		const values = current.values.filter((one) => one !== value);
		writeUnsynced(values.length > 0 ? { userId: current.userId, values } : null);
	}
}

function writeUnsynced(value: Unsynced | null): void {
	try {
		if (value === null) {
			localStorage.removeItem(UNSYNCED_KEY);
		} else {
			localStorage.setItem(UNSYNCED_KEY, JSON.stringify(value));
		}
	} catch {
		// Storage unavailable: the value stays on this device only.
	}
}

function writeLocal(list: readonly string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch {
		// Storage full or unavailable: the list stays for this session.
	}
}
