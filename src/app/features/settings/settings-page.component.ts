import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BoardThemeService } from '../../core/board/board-theme.service';
import { BOARD_THEMES } from '../../core/board/board-themes';
import { pieceSetFor } from '../../core/board/piece-sets';
import { CloudStorageService } from '../../core/services/cloud-storage.service';
import { SessionSummary } from '../../core/models/user.model';
import { ARROW_PALETTE, ARROW_SLOTS, MoveDestStyle } from '../../core/models/preferences.model';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { PreferencesStore } from '../../core/services/preferences.store';
import { ThemeName, ThemeService } from '../../core/services/theme.service';
import { MoveSoundService } from '../../core/sound/move-sound.service';
import { CustomThemeService } from '../../core/theme/custom-theme.service';
import { CUSTOM_COLOR_PRESETS, CUSTOM_COLOR_SLOTS, legibility } from '../../core/theme/custom-theme';
import { ColorPickerComponent } from '../../shared/color-picker/color-picker.component';
import { SettingsPreviewComponent } from './settings-preview.component';
import { PasswordRevealDirective } from '../../shared/password-reveal/password-reveal.directive';
import { RecoveryCodeComponent } from './recovery-code.component';

const MIN_PASSWORD = 8;

// Not a hash limit: the server only ever sees a fixed-length KDF output, never the raw password.
const MAX_PASSWORD = 200;

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
	['second', 60],
	['minute', 60],
	['hour', 24],
	['day', 30],
	['month', 12],
];

@Component({
	selector: 'app-settings-page',
	standalone: true,
	imports: [RouterLink, SettingsPreviewComponent, ColorPickerComponent, PasswordRevealDirective, RecoveryCodeComponent],
	templateUrl: './settings-page.component.html',
	styleUrl: './settings-page.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPageComponent {
	readonly auth = inject(AuthService);

	// The date only; the recovery code itself is never held here, since nothing stores it.
	private readonly vaultUpdatedAt = signal<string | null>(null);

	readonly recoveryCodeCreated = computed(() => {
		const at = this.vaultUpdatedAt();
		return at === null ? 'Not created yet' : `Created ${formatDay(at)}`;
	});

	readonly theme = inject(ThemeService);
	readonly prefs = inject(PreferencesStore);
	private readonly boardTheme = inject(BoardThemeService);
	private readonly sounds = inject(MoveSoundService);
	private readonly customTheme = inject(CustomThemeService);
	private readonly route = inject(ActivatedRoute);
	private readonly router = inject(Router);
	private readonly notify = inject(NotificationService);

	readonly boardThemes = BOARD_THEMES;
	readonly arrowSlots = ARROW_SLOTS;
	readonly palette = ARROW_PALETTE;

	readonly pieceSets = computed(() => this.boardTheme.installedPieceSets().map(pieceSetFor));
	readonly onlyBundledSet = computed(() => this.pieceSets().length <= 1);

	readonly soundInstalled = this.sounds.available;

	readonly colorSlots = CUSTOM_COLOR_SLOTS;

	private readonly baseSurfaces = signal<readonly string[]>(CUSTOM_COLOR_SLOTS.map(() => '#ffffff'));
	private readonly baseText = signal('#000000');

	readonly surfaceColors = computed<readonly string[]>(() => this.prefs.customColors() ?? this.baseSurfaces());

	readonly themeMode = computed<'light' | 'dark' | 'custom'>(() =>
		this.prefs.customColors() ? 'custom' : this.theme.theme(),
	);

	readonly surfaceWarning = computed<string | null>(() => {
		const colours = this.prefs.customColors();
		if (!colours) return null;

		const text = this.baseText();
		const unreadable = CUSTOM_COLOR_SLOTS.findIndex((_, i) => legibility(colours[i], text) === 'unreadable');
		if (unreadable >= 0) {
			return `${CUSTOM_COLOR_SLOTS[unreadable].name} is too close to the text colour of ${this.theme.theme()} mode - words on it will be hard to make out. Try the other end of the row, or switch modes.`;
		}

		const poor = CUSTOM_COLOR_SLOTS.findIndex((_, i) => legibility(colours[i], text) === 'poor');
		if (poor >= 0) {
			return `${CUSTOM_COLOR_SLOTS[poor].name} is low-contrast against ${this.theme.theme()} mode's text. It is readable, but not comfortably.`;
		}
		return null;
	});

	presetsFor(slot: number): readonly string[] {
		return CUSTOM_COLOR_PRESETS[slot] ?? [];
	}

	chooseSurface(slot: number, colour: string): void {
		const next = this.surfaceColors().map((existing, index) => (index === slot ? colour : existing));
		this.prefs.update('customColors', next);
	}

	clearSurfaces(): void {
		this.prefs.update('customColors', null);
	}

	private readonly cloud = inject(CloudStorageService);
	readonly storage = this.cloud.usage;

	readonly storagePercent = computed(() => Math.min(100, this.cloud.percent()));

	readonly storageLevel = computed(() => {
		if (this.cloud.overQuota()) return 'full';
		return this.cloud.percent() >= 75 ? 'high' : 'normal';
	});

	readonly editingUsername = signal(false);
	readonly usernameDraft = signal('');
	readonly usernameBusy = signal(false);
	readonly usernameError = signal('');

	readonly usernameValid = computed(() => {
		const value = this.usernameDraft().trim();
		return value.length >= 3 && value.length <= 32 && /^[A-Za-z0-9_-]+$/.test(value);
	});

	readonly editingPassword = signal(false);
	readonly currentPassword = signal('');
	readonly newPassword = signal('');
	readonly confirmPassword = signal('');
	readonly passwordBusy = signal(false);
	readonly passwordError = signal('');
	readonly passwordDone = signal('');

	readonly passwordProblem = computed(() => {
		const next = this.newPassword();
		const confirm = this.confirmPassword();

		if (next.length > 0 && next.length < MIN_PASSWORD) {
			return `Use at least ${MIN_PASSWORD} characters.`;
		}
		if (next.length > MAX_PASSWORD) {
			return `That is longer than ${MAX_PASSWORD} characters, which is as much as the hash can hold.`;
		}
		if (confirm.length > 0 && confirm !== next) {
			return 'The two new passwords do not match.';
		}
		if (next.length > 0 && next === this.currentPassword()) {
			return 'That is the password you already have.';
		}
		return '';
	});

	readonly passwordReady = computed(
		() =>
			this.currentPassword().length > 0 &&
			this.newPassword().length >= MIN_PASSWORD &&
			this.confirmPassword() === this.newPassword() &&
			this.passwordProblem() === '',
	);

	readonly sessions = signal<readonly SessionSummary[]>([]);
	readonly sessionsLoaded = signal(false);
	readonly sessionsError = signal('');
	readonly sessionBusy = signal<number | null>(null);
	readonly othersBusy = signal(false);

	readonly hasOtherSessions = computed(() => this.sessions().some((session) => !session.current));

	readonly deleting = signal(false);
	readonly deleteConfirm = signal('');
	readonly deleteBusy = signal(false);
	readonly deleteError = signal('');

	// Exact match, not a checkbox: typing the visible username is the deliberate confirmation step.
	readonly deleteReady = computed(() => {
		const username = this.auth.currentUser()?.username;
		return username !== undefined && this.deleteConfirm().trim() === username;
	});

	startDelete(): void {
		this.deleteConfirm.set('');
		this.deleteError.set('');
		this.deleting.set(true);
	}

	cancelDelete(): void {
		this.deleting.set(false);
		this.deleteConfirm.set('');
		this.deleteError.set('');
	}

	loadSessions(): void {
		if (!this.auth.isLoggedIn()) return;

		this.auth.sessions().subscribe({
			next: (list) => {
				this.sessions.set(list);
				this.sessionsLoaded.set(true);
				this.sessionsError.set('');
			},
			error: (err: Error) => {
				this.sessionsLoaded.set(true);
				this.sessionsError.set(err.message);
			},
		});
	}

	endSession(session: SessionSummary): void {
		if (this.sessionBusy() !== null) return;

		if (session.current) {
			// Ending the current session signs out and clears local auth state, not only the server row.
			this.auth.logout();
			void this.router.navigateByUrl('/home');
			return;
		}

		this.sessionBusy.set(session.id);
		this.sessionsError.set('');
		this.auth.endSession(session.id).subscribe({
			next: () => {
				this.sessionBusy.set(null);
				this.loadSessions();
			},
			error: (err: Error) => {
				this.sessionBusy.set(null);
				this.sessionsError.set(err.message);
			},
		});
	}

	endOtherSessions(): void {
		if (this.othersBusy()) return;

		this.othersBusy.set(true);
		this.sessionsError.set('');
		this.auth.endOtherSessions().subscribe({
			next: () => {
				this.othersBusy.set(false);
				this.loadSessions();
				this.notify.info('Every other browser has been signed out.');
			},
			error: (err: Error) => {
				this.othersBusy.set(false);
				this.sessionsError.set(err.message);
			},
		});
	}

	since(iso: string): string {
		const then = Date.parse(iso);
		if (Number.isNaN(then)) {
			return 'at an unknown time';
		}

		let value = (then - Date.now()) / 1000;
		for (const [unit, span] of UNITS) {
			if (Math.abs(value) < span) {
				return RELATIVE.format(Math.round(value), unit);
			}
			value /= span;
		}
		return RELATIVE.format(Math.round(value), 'year');
	}

	confirmDelete(): void {
		if (!this.deleteReady() || this.deleteBusy()) return;

		this.deleteBusy.set(true);
		this.deleteError.set('');
		this.auth.deleteAccount(this.deleteConfirm().trim()).subscribe({
			next: () => {
				this.deleteBusy.set(false);
				this.deleting.set(false);
				this.auth.logout();
				void this.router.navigateByUrl('/home');
				this.notify.info('Your account and everything in it have been deleted.');
			},
			error: (err: Error) => {
				this.deleteBusy.set(false);
				this.deleteError.set(err.message);
			},
		});
	}

	constructor() {
		this.route.fragment.pipe(takeUntilDestroyed()).subscribe((fragment) => this.scrollTo(fragment));
		this.refreshStorage();
		this.refreshRecoveryCodeDate();

		effect(() => {
			this.theme.theme();
			this.baseSurfaces.set(this.customTheme.baseColors());
			this.baseText.set(this.customTheme.readBaseText());
		});
	}

	@HostListener('window:focus')
	refreshStorage(): void {
		if (!this.auth.isLoggedIn()) return;
		this.cloud.refresh();
		this.loadSessions();
	}

	formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

		const megabytes = bytes / (1024 * 1024);
		return `${megabytes >= 10 ? Math.round(megabytes) : parseFloat(megabytes.toFixed(2))} MB`;
	}

	setTheme(theme: ThemeName): void {
		this.theme.set(theme);
		if (this.prefs.customColors()) {
			this.prefs.update('customColors', null);
		}
	}

	useCustom(): void {
		if (this.prefs.customColors()) {
			return;
		}
		// Read fresh here rather than via baseSurfaces(), which only updates on theme change and could
		// still hold a mode the user has since left.
		const base = this.customTheme.baseColors();
		this.baseSurfaces.set(base);
		this.prefs.update('customColors', [...base]);
	}

	choosePieceSet(id: string): void {
		this.prefs.update('pieceSet', id);
	}

	chooseBoardTheme(id: string): void {
		this.prefs.update('boardTheme', id);
	}

	setCoordinates(shown: boolean): void {
		this.prefs.update('coordinates', shown);
	}

	setMoveDests(style: MoveDestStyle): void {
		this.prefs.update('moveDests', style);
	}

	setSound(on: boolean): void {
		this.prefs.update('sound', on);
		if (on) {
			this.sounds.prime();
		}
	}

	chooseArrowColor(slot: number, colour: string): void {
		const next = this.prefs.arrowColors().map((existing, index) => (index === slot ? colour : existing));
		this.prefs.update('arrowColors', next);
	}

	resetBoard(): void {
		this.prefs.resetToDefaults();
	}

	saveBoard(): void {
		this.prefs.save();
	}

	startUsernameEdit(): void {
		this.usernameDraft.set(this.auth.currentUser()?.username ?? '');
		this.usernameError.set('');
		this.editingUsername.set(true);
	}

	cancelUsernameEdit(): void {
		this.editingUsername.set(false);
		this.usernameError.set('');
	}

	submitUsername(): void {
		if (!this.usernameValid() || this.usernameBusy()) return;

		const wanted = this.usernameDraft().trim();
		if (wanted === this.auth.currentUser()?.username) {
			this.cancelUsernameEdit();
			return;
		}

		this.usernameBusy.set(true);
		this.usernameError.set('');
		this.auth.changeUsername(wanted).subscribe({
			next: () => {
				this.usernameBusy.set(false);
				this.editingUsername.set(false);
			},
			error: (err: Error) => {
				this.usernameBusy.set(false);
				this.usernameError.set(err.message);
			},
		});
	}

	togglePasswordForm(): void {
		const opening = !this.editingPassword();
		this.editingPassword.set(opening);
		if (!opening) {
			this.clearPasswordFields();
		}
		this.passwordDone.set('');
		this.passwordError.set('');
	}

	submitPassword(): void {
		if (!this.passwordReady() || this.passwordBusy()) return;

		this.passwordBusy.set(true);
		this.passwordError.set('');
		this.auth.changePassword(this.currentPassword(), this.newPassword()).subscribe({
			next: () => {
				this.passwordBusy.set(false);
				this.clearPasswordFields();
				this.editingPassword.set(false);
				this.passwordDone.set('Your password has been changed. Any other device is now signed out.');
				this.loadSessions();
			},
			error: (err: Error) => {
				this.passwordBusy.set(false);
				this.passwordError.set(err.message);
			},
		});
	}

	clearPasswordNotice(): void {
		if (this.passwordError() !== '') this.passwordError.set('');
		if (this.passwordDone() !== '') this.passwordDone.set('');
	}

	private clearPasswordFields(): void {
		this.currentPassword.set('');
		this.newPassword.set('');
		this.confirmPassword.set('');
	}

	private scrollTo(fragment: string | null): void {
		const target = fragment ?? 'account';

		setTimeout(() => {
			document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	}

	private refreshRecoveryCodeDate(): void {
		this.auth.vaultSummary().subscribe({
			next: (vault) => this.vaultUpdatedAt.set(vault.updatedAt ?? vault.createdAt),
			// A nicety; failing to show the date isn't worth surfacing as an error.
			error: () => this.vaultUpdatedAt.set(null),
		});
	}
}

function formatDay(iso: string): string {
	const at = new Date(iso);
	return Number.isNaN(at.getTime())
		? 'recently'
		: at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
