import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { BoardThemeService } from '../board/board-theme.service';
import {
	AppPreferences,
	DEFAULT_PREFERENCES,
	normalisePreferences,
	preferencesEqual,
} from '../models/preferences.model';
import { UserSummary } from '../models/user.model';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { CustomThemeService } from '../theme/custom-theme.service';

const STORAGE_KEY = 'premovedprep.preferences';

@Injectable({ providedIn: 'root' })
export class PreferencesStore {
	private readonly http = inject(HttpClient);
	private readonly auth = inject(AuthService);
	private readonly theme = inject(ThemeService);
	private readonly boardTheme = inject(BoardThemeService);
	private readonly customTheme = inject(CustomThemeService);

	private readonly draft = signal<AppPreferences>(DEFAULT_PREFERENCES);
	private readonly committed = signal<AppPreferences>(DEFAULT_PREFERENCES);

	readonly preferences = this.draft.asReadonly();
	readonly saved = this.committed.asReadonly();

	readonly pieceSet = computed(() => this.draft().pieceSet);
	readonly boardThemeId = computed(() => this.draft().boardTheme);
	readonly coordinates = computed(() => this.draft().coordinates);
	readonly moveDests = computed(() => this.draft().moveDests);
	readonly arrowColors = computed(() => this.draft().arrowColors);
	readonly sound = computed(() => this.draft().sound);
	readonly customColors = computed(() => this.draft().customColors);

	readonly dirty = computed(() => !preferencesEqual(this.draft(), this.committed()));
	readonly atDefaults = computed(() => preferencesEqual(this.draft(), DEFAULT_PREFERENCES));

	private syncTimer: ReturnType<typeof setTimeout> | null = null;

	private adopted = false;

	constructor() {
		let first = true;
		effect(() => {
			this.theme.theme();
			if (first) {
				first = false;
				return;
			}
			untracked(() => this.scheduleSync());
		});

		effect(() => {
			const user = this.auth.currentUser();
			// Cleared on the way out, not only set on the way in: otherwise signing in as a second
			// account in the same tab would keep the first one's board and theme.
			if (!user) {
				this.adopted = false;
				return;
			}
			if (this.adopted) return;
			untracked(() => this.adopt(user));
		});
	}

	init(): void {
		const stored = this.read();
		this.committed.set(stored);
		this.draft.set(stored);
		this.repaint();
		// Not awaited: the manifest only decides which sets the picker offers.
		void this.boardTheme.loadInstalledPieceSets().then(() => this.repaint());
	}

	update<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]): void {
		const next = { ...this.draft(), [key]: value };
		if (preferencesEqual(next, this.draft())) return;

		this.draft.set(next);
		this.repaint();
	}

	resetToDefaults(): void {
		if (this.atDefaults()) return;
		this.draft.set(DEFAULT_PREFERENCES);
		this.repaint();
	}

	discard(): void {
		if (!this.dirty()) return;
		this.draft.set(this.committed());
		this.repaint();
	}

	save(): void {
		if (!this.dirty()) return;

		const next = this.draft();
		this.committed.set(next);
		this.write(next);
		this.scheduleSync();
	}

	private repaint(): void {
		const current = this.draft();
		this.boardTheme.apply(current.boardTheme, current.pieceSet);
		this.customTheme.apply(current.customColors);
	}

	private read(): AppPreferences {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			return stored ? normalisePreferences(JSON.parse(stored)) : DEFAULT_PREFERENCES;
		} catch {
			return DEFAULT_PREFERENCES;
		}
	}

	private write(value: AppPreferences): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
		} catch {
			// Private mode, or the quota is full: preferences stay in memory for this session.
		}
	}

	private adopt(user: UserSummary): void {
		this.adopted = true;

		if (user.boardPreferences) {
			try {
				const remote = normalisePreferences(JSON.parse(user.boardPreferences));
				this.committed.set(remote);
				this.draft.set(remote);
				this.write(remote);
				this.repaint();
			} catch {
				// Unreadable preferences on the account: keep the ones already applied.
			}
		}

		if (user.themePreference === 'light' || user.themePreference === 'dark') {
			this.theme.set(user.themePreference);
		}

		// A new account keeps this machine's board setup, but not a custom colour experiment.
		if (!user.boardPreferences) {
			if (this.draft().customColors) {
				this.update('customColors', null);
			}
			this.save();
			this.scheduleSync();
		}
	}

	private scheduleSync(): void {
		if (!this.auth.isLoggedIn()) return;

		if (this.syncTimer !== null) {
			clearTimeout(this.syncTimer);
		}
		this.syncTimer = setTimeout(() => {
			this.syncTimer = null;
			this.push();
		}, 400);
	}

	// One PATCH for both halves, sending the committed copy rather than the draft.
	private push(): void {
		if (!this.auth.isLoggedIn()) return;

		this.http
			.patch<UserSummary>(`${environment.apiBaseUrl}/auth/me/preferences`, {
				themePreference: this.theme.theme(),
				boardPreferences: JSON.stringify(this.committed()),
			})
			.subscribe({ error: () => undefined });
	}
}
