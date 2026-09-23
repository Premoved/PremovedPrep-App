import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { LogoComponent } from '../../shared/logo/logo.component';
import { BotCheckComponent } from '../../shared/captcha/bot-check.component';
import { BotCheck } from '../../core/captcha/bot-check';
import { CaptchaAnswer } from '../../core/captcha/captcha.model';
import { PasswordRevealDirective } from '../../shared/password-reveal/password-reveal.directive';

// Must match the @Pattern on AuthDtos.RegisterRequest.
const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;

@Component({
	selector: 'app-register',
	standalone: true,
	imports: [RouterLink, LogoComponent, BotCheckComponent, PasswordRevealDirective],
	templateUrl: './register.component.html',
	styleUrl: './auth-form.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterComponent {
	private readonly auth = inject(AuthService);
	private readonly router = inject(Router);
	private readonly notices = inject(NotificationService);

	readonly username = signal('');
	readonly email = signal('');
	readonly password = signal('');

	readonly acceptedTerms = signal(false);

	readonly touchedUsername = signal(false);
	readonly touchedPassword = signal(false);

	readonly error = signal<string | null>(null);
	readonly submitting = signal(false);

	readonly botCheck = new BotCheck();

	readonly usernameProblem = computed(() => {
		const value = this.username().trim();
		if (value.length === 0) {
			return null;
		}
		if (value.length < 3 || value.length > 32) {
			return 'Between 3 and 32 characters.';
		}
		return USERNAME_PATTERN.test(value) ? null : 'Letters, digits, underscores and hyphens only.';
	});

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

	readonly canSubmit = computed(
		() =>
			this.username().trim().length >= 3 &&
			this.email().trim().length > 0 &&
			this.password().length >= 8 &&
			this.acceptedTerms() &&
			this.usernameProblem() === null &&
			this.passwordProblem() === null &&
			!this.submitting(),
	);

	onUsername(event: Event): void {
		this.username.set((event.target as HTMLInputElement).value);
	}

	onEmail(event: Event): void {
		this.email.set((event.target as HTMLInputElement).value);
	}

	onPassword(event: Event): void {
		this.password.set((event.target as HTMLInputElement).value);
	}

	readonly usernameHint = computed(() => (this.touchedUsername() ? (this.usernameProblem() ?? '') : ''));
	readonly passwordHint = computed(() => (this.touchedPassword() ? (this.passwordProblem() ?? '') : ''));

	onBotCheckSolved(answer: CaptchaAnswer): void {
		this.botCheck.accept(answer);
	}

	submit(event: Event): void {
		event.preventDefault();
		if (!this.canSubmit() || this.botCheck.blocked()) {
			return;
		}
		this.send();
	}

	private send(): void {
		this.error.set(null);
		this.submitting.set(true);

		this.auth
			.register(
				this.username().trim(),
				this.email().trim(),
				this.password(),
				this.acceptedTerms(),
				this.botCheck.take(),
			)
			.subscribe({
				next: (created) => {
					// False when the mail provider refused; the account exists either way.
					if (!created.verificationSent) {
						this.notices.error(
							'Your account was created, but we could not send the confirmation email. Try sending it again.',
						);
					}
					this.router.navigateByUrl('/verify-email', { state: { email: created.email } });
				},
				error: (err: Error) => {
					this.submitting.set(false);
					if (this.botCheck.adopt(err)) {
						return;
					}
					this.error.set(err.message);
				},
			});
	}
}
