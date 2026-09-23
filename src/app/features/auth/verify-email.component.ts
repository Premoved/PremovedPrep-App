import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { LogoComponent } from '../../shared/logo/logo.component';
import { BotCheckComponent } from '../../shared/captcha/bot-check.component';
import { BotCheck } from '../../core/captcha/bot-check';
import { CaptchaAnswer } from '../../core/captcha/captcha.model';

@Component({
	selector: 'app-verify-email',
	standalone: true,
	imports: [RouterLink, LogoComponent, BotCheckComponent],
	templateUrl: './verify-email.component.html',
	styleUrl: './auth-form.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VerifyEmailComponent {
	private readonly auth = inject(AuthService);
	private readonly router = inject(Router);
	private readonly route = inject(ActivatedRoute);
	private readonly notices = inject(NotificationService);

	readonly confirming = signal(false);

	readonly error = signal<string | null>(null);

	readonly email = signal('');
	readonly resending = signal(false);
	readonly resent = signal(false);

	readonly botCheck = new BotCheck();

	readonly canResend = computed(() => this.email().trim().length > 0 && !this.resending());

	constructor() {
		const token = this.route.snapshot.queryParamMap.get('token');

		const handedOver = this.router.getCurrentNavigation()?.extras.state?.['email'];
		if (typeof handedOver === 'string') {
			this.email.set(handedOver);
		}

		if (token) {
			this.confirm(token);
		}
	}

	onEmail(event: Event): void {
		this.email.set((event.target as HTMLInputElement).value);
	}

	onBotCheckSolved(answer: CaptchaAnswer): void {
		this.botCheck.accept(answer);
	}

	resend(event: Event): void {
		event.preventDefault();
		if (!this.canResend() || this.botCheck.blocked()) {
			return;
		}
		this.sendAgain();
	}

	private sendAgain(): void {
		this.resending.set(true);
		this.auth.resendVerification(this.email().trim(), this.botCheck.take()).subscribe({
			next: () => {
				this.resending.set(false);
				this.resent.set(true);
			},
			error: (err: Error) => {
				this.resending.set(false);
				if (this.botCheck.adopt(err)) {
					return;
				}
				this.notices.error(err.message);
			},
		});
	}

	private confirm(token: string): void {
		this.confirming.set(true);

		this.auth.verifyEmail(token).subscribe({
			next: () => {
				// No session is created here; sign-in still needs the password to derive the vault key.
				this.notices.info('Your email address is confirmed. Sign in to continue.');
				this.router.navigateByUrl('/login');
			},
			error: (err: Error) => {
				this.confirming.set(false);
				this.error.set(err.message);
			},
		});
	}
}
