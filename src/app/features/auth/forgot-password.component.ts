import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { LogoComponent } from '../../shared/logo/logo.component';
import { BotCheckComponent } from '../../shared/captcha/bot-check.component';
import { BotCheck } from '../../core/captcha/bot-check';
import { CaptchaAnswer } from '../../core/captcha/captcha.model';

@Component({
	selector: 'app-forgot-password',
	standalone: true,
	imports: [RouterLink, LogoComponent, BotCheckComponent],
	templateUrl: './forgot-password.component.html',
	styleUrl: './auth-form.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForgotPasswordComponent {
	private readonly auth = inject(AuthService);
	private readonly notices = inject(NotificationService);

	readonly email = signal('');
	readonly submitting = signal(false);
	// Set once the request completes; says nothing about whether a mail was actually sent.
	readonly asked = signal(false);

	readonly botCheck = new BotCheck();

	readonly canSubmit = computed(() => this.email().trim().length > 0 && !this.submitting());

	onEmail(event: Event): void {
		this.email.set((event.target as HTMLInputElement).value);
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
		this.submitting.set(true);
		this.auth.forgotPassword(this.email().trim(), this.botCheck.take()).subscribe({
			next: () => {
				this.submitting.set(false);
				this.asked.set(true);
			},
			error: (err: Error) => {
				this.submitting.set(false);
				if (this.botCheck.adopt(err)) {
					return;
				}
				this.notices.error(err.message);
			},
		});
	}
}
