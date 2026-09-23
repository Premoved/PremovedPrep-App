import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { LogoComponent } from '../../shared/logo/logo.component';
import { PasswordRevealDirective } from '../../shared/password-reveal/password-reveal.directive';
import { readRecoveryCode } from '../../core/crypto/recovery-code';
import { ResetContext } from '../../core/models/user.model';

@Component({
	selector: 'app-reset-password',
	standalone: true,
	imports: [RouterLink, LogoComponent, PasswordRevealDirective],
	templateUrl: './reset-password.component.html',
	styleUrl: './auth-form.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResetPasswordComponent {
	private readonly auth = inject(AuthService);
	private readonly router = inject(Router);
	private readonly route = inject(ActivatedRoute);
	private readonly notices = inject(NotificationService);

	readonly token = signal(this.route.snapshot.queryParamMap.get('token') ?? '');

	constructor() {
		if (this.token().length > 0) {
			this.auth.resetContext(this.token()).subscribe({
				next: (context) => {
					this.context.set(context);
					this.recognised.set(this.auth.unlockedHere());
				},
				error: (err: Error) => this.error.set(err.message),
			});
		}
	}

	readonly password = signal('');
	readonly confirmation = signal('');

	readonly recoveryCode = signal('');
	readonly acceptsLoss = signal(false);

	// GET /reset-password/context does not spend the token; only POST /reset-password does.
	readonly context = signal<ResetContext | null>(null);

	readonly recognised = signal(false);

	readonly checking = signal(false);
	readonly codeRejected = signal(false);
	readonly touchedPassword = signal(false);
	readonly touchedConfirmation = signal(false);

	readonly error = signal<string | null>(null);
	readonly submitting = signal(false);

	readonly passwordProblem = computed(() => {
		const value = this.password();
		if (value.length === 0) {
			return null;
		}
		// The server only ever sees a derived secret, not the password, so it cannot enforce a length cap.
		if (value.length > 200) {
			return 'At most 200 characters.';
		}
		return value.length < 8 ? 'At least 8 characters.' : null;
	});

	readonly confirmationProblem = computed(() => {
		if (this.confirmation().length === 0) {
			return null;
		}
		return this.confirmation() === this.password() ? null : 'The two do not match.';
	});

	readonly passwordHint = computed(() => (this.touchedPassword() ? (this.passwordProblem() ?? '') : ''));
	readonly confirmationHint = computed(() => (this.touchedConfirmation() ? (this.confirmationProblem() ?? '') : ''));

	readonly recoveryCodeProblem = computed(() => {
		if (this.codeRejected()) {
			return 'Invalid recovery code';
		}
		const typed = this.recoveryCode().trim();
		if (typed.length === 0) {
			return null;
		}
		return readRecoveryCode(typed) === null ? 'Invalid recovery code' : null;
	});

	readonly hasRecoveryCode = computed(
		() => this.recoveryCode().trim().length > 0 && readRecoveryCode(this.recoveryCode().trim()) !== null,
	);

	readonly mustAcceptLoss = computed(() => !this.recognised() && this.recoveryCode().trim().length === 0);

	readonly canSubmit = computed(
		() =>
			this.token().length > 0 &&
			this.password().length >= 8 &&
			this.passwordProblem() === null &&
			this.confirmationProblem() === null &&
			this.confirmation().length > 0 &&
			this.recoveryCodeProblem() === null &&
			(this.recognised() || this.hasRecoveryCode() || this.acceptsLoss()) &&
			!this.submitting() &&
			!this.checking(),
	);

	onRecoveryCode(event: Event): void {
		this.recoveryCode.set((event.target as HTMLInputElement).value);
		this.codeRejected.set(false);
	}

	onAcceptsLoss(event: Event): void {
		this.acceptsLoss.set((event.target as HTMLInputElement).checked);
	}

	onPassword(event: Event): void {
		this.password.set((event.target as HTMLInputElement).value);
	}

	onConfirmation(event: Event): void {
		this.confirmation.set((event.target as HTMLInputElement).value);
	}

	submit(event: Event): void {
		event.preventDefault();
		if (!this.canSubmit()) {
			return;
		}
		void this.send();
	}

	private async send(): Promise<void> {
		this.error.set(null);
		const typed = this.recoveryCode().trim();
		const context = this.context();

		// Verify the recovery code before resetPassword spends the token: a wrong code must not delete data.
		let code: string | null = null;
		if (!this.recognised() && typed.length > 0 && context !== null) {
			this.checking.set(true);
			const correct = await this.auth.verifyRecoveryCode(typed, context);
			this.checking.set(false);

			if (!correct) {
				this.codeRejected.set(true);
				return;
			}
			code = typed;
		}

		this.submitting.set(true);
		this.auth.resetPassword(this.token(), this.password(), code).subscribe({
			next: () => {
				this.notices.info('Your password has been changed');
				this.router.navigateByUrl('/login');
			},
			error: (err: Error) => {
				this.error.set(err.message);
				this.submitting.set(false);
			},
		});
	}
}
