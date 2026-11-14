import { Injectable, computed, inject, signal } from '@angular/core';
import { FIDE_TIME_CONTROLS } from '../chess/time-control';
import { AuthService } from './auth.service';
import { TimeControlApiService } from './time-control-api.service';

const STORAGE_KEY = 'premovedprep.timeControls';

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
			next: (list) => this.account.set(list.map((entry) => entry.value)),
			error: () => undefined,
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
		if (this.auth.isLoggedIn() && !this.account().includes(value)) {
			this.api.create(value).subscribe({
				next: () => this.refresh(),
				error: () => undefined,
			});
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

function writeLocal(list: readonly string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch {
		// Storage full or unavailable: the list stays for this session.
	}
}
