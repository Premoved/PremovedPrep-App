import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { PasswordRevealDirective } from '../../shared/password-reveal/password-reveal.directive';
import { saveBlob } from '../../core/browser/download';

@Component({
	selector: 'app-recovery-code',
	standalone: true,
	imports: [PasswordRevealDirective],
	templateUrl: './recovery-code.component.html',
	styleUrl: './recovery-code.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecoveryCodeComponent {
	private readonly auth = inject(AuthService);
	private readonly notices = inject(NotificationService);

	readonly code = this.auth.pendingRecoveryCode;

	readonly asking = signal(false);

	readonly password = signal('');
	readonly error = signal<string | null>(null);
	readonly busy = signal(false);

	readonly kept = signal(false);

	readonly open = computed(() => this.asking() || this.code() !== null);

	readonly canGenerate = computed(() => this.password().length > 0 && !this.busy());

	startGenerating(): void {
		this.password.set('');
		this.error.set(null);
		this.kept.set(false);
		this.asking.set(true);
	}

	onPassword(event: Event): void {
		this.password.set((event.target as HTMLInputElement).value);
		this.error.set(null);
	}

	onKept(event: Event): void {
		this.kept.set((event.target as HTMLInputElement).checked);
	}

	generate(event: Event): void {
		event.preventDefault();
		if (!this.canGenerate()) {
			return;
		}

		this.busy.set(true);
		this.auth.replaceRecoveryCode(this.password()).subscribe({
			next: () => {
				this.busy.set(false);
				this.asking.set(false);
				this.password.set('');
			},
			error: (err: Error) => {
				this.busy.set(false);
				this.error.set(err.message);
			},
		});
	}

	async copy(): Promise<void> {
		const code = this.code();
		if (code === null) {
			return;
		}

		try {
			await navigator.clipboard.writeText(code);
			this.notices.info('Recovery code copied');
		} catch {
			this.notices.error('This browser would not let the page copy. Write the code down instead.');
		}
	}

	download(): void {
		const code = this.code();
		if (code === null) {
			return;
		}

		const body = [
			'PremovedPrep recovery code',
			'',
			`Account: ${this.auth.currentUser()?.email ?? ''}`,
			`Code:    ${code}`,
			'',
			'Your pgn files are encrypted before they are saved in cloud. If you ever forget your',
			'password and are logged out from all devices, you will need this code when resetting',
			'your password to recover your pgn files.',
			'',
			'It is not stored anywhere else. PremovedPrep cannot show it to you again.',
			'',
		].join('\n');

		saveBlob(new Blob([body], { type: 'text/plain' }), 'premovedprep-recovery-code.txt');
	}

	done(): void {
		if (!this.kept()) {
			return;
		}

		this.busy.set(true);
		void this.auth
			.acknowledgeRecoveryCode()
			.catch(() => {
				// Ack failure isn't surfaced; the code is already shown, and the next sign-in offers a new one.
			})
			.finally(() => {
				this.busy.set(false);
				this.kept.set(false);
			});
	}

	// No-op while a code is showing: closing without confirming it was kept is refused.
	dismiss(): void {
		if (this.code() === null) {
			this.asking.set(false);
		}
	}
}
