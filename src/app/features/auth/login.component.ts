import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { ApiError } from '../../core/interceptors/error.interceptor';
import { LogoComponent } from '../../shared/logo/logo.component';
import { BotCheckComponent } from '../../shared/captcha/bot-check.component';
import { BotCheck } from '../../core/captcha/bot-check';
import { CaptchaAnswer } from '../../core/captcha/captcha.model';
import { PasswordRevealDirective } from '../../shared/password-reveal/password-reveal.directive';

@Component({
	selector: 'app-login',
	standalone: true,
	imports: [RouterLink, LogoComponent, BotCheckComponent, PasswordRevealDirective],
	templateUrl: './login.component.html',
	styleUrl: './auth-form.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
	private readonly auth = inject(AuthService);
	private readonly router = inject(Router);
	private readonly route = inject(ActivatedRoute);

	readonly email = signal('');
	readonly password = signal('');

	// Always true: this is one person's own computer, not a shared or public one.
	private readonly keepSignedIn = true;

	readonly error = signal<string | null>(null);
	readonly submitting = signal(false);

	// Set when the last failure was an unconfirmed address.
	readonly unconfirmed = signal(false);

	readonly botCheck = new BotCheck();

	readonly canSubmit = computed(
		() => this.email().trim().length > 0 && this.password().length > 0 && !this.submitting(),
	);

	onEmail(event: Event): void {
		this.email.set((event.target as HTMLInputElement).value);
	}

	onPassword(event: Event): void {
		this.password.set((event.target as HTMLInputElement).value);
	}

	goToConfirmation(event: Event): void {
		event.preventDefault();
		this.router.navigateByUrl('/verify-email', { state: { email: this.email().trim() } });
	}

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
		this.unconfirmed.set(false);
		this.submitting.set(true);

		this.auth.login(this.email().trim(), this.password(), this.keepSignedIn, this.botCheck.take()).subscribe({
			next: () => {
				// A freshly issued recovery code is shown on the settings page; send them there
				// instead of wherever they were headed.
				if (this.auth.pendingRecoveryCode() !== null) {
					this.router.navigateByUrl('/settings#account');
					return;
				}

				const redirectTo = this.route.snapshot.queryParamMap.get('redirectTo') ?? '/home';
				this.router.navigateByUrl(redirectTo);
			},
			error: (err: Error) => {
				this.submitting.set(false);
				if (this.botCheck.adopt(err)) {
					return;
				}
				this.error.set(err.message);
				this.unconfirmed.set(err instanceof ApiError && err.status === 403);
			},
		});
	}
}
