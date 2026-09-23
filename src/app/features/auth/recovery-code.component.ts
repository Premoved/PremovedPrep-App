import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LogoComponent } from '../../shared/logo/logo.component';
import { NotificationService } from '../../core/services/notification.service';
import { saveBlob } from '../../core/browser/download';

@Component({
	selector: 'app-recovery-code',
	standalone: true,
	imports: [LogoComponent, RouterLink],
	templateUrl: './recovery-code.component.html',
	styleUrl: './auth-form.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecoveryCodeComponent {
	private readonly router = inject(Router);
	private readonly notices = inject(NotificationService);

	// Router state, not a query param: keeps the code out of the URL, browser history and referrers.
	private readonly state = this.router.getCurrentNavigation()?.extras.state ?? history.state ?? {};

	readonly code = signal<string>(typeof this.state['recoveryCode'] === 'string' ? this.state['recoveryCode'] : '');
	readonly email = signal<string>(typeof this.state['email'] === 'string' ? this.state['email'] : '');

	readonly written = signal(false);

	readonly missing = computed(() => this.code().length === 0);

	readonly canContinue = computed(() => this.written() && !this.missing());

	onWritten(event: Event): void {
		this.written.set((event.target as HTMLInputElement).checked);
	}

	async copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.code());
			this.notices.info('Recovery code copied. Paste it somewhere it will still be there in a year.');
		} catch {
			this.notices.error('This browser would not let the page copy. Write the code down instead.');
		}
	}

	download(): void {
		const body = [
			'PremovedPrep recovery code',
			'',
			`Account: ${this.email()}`,
			`Code:    ${this.code()}`,
			'',
			'This code is the only way to reach your saved games and repertoires if you forget your',
			'password. It was created in your browser and was never sent to PremovedPrep, so nobody',
			'there can look it up or send it to you again. Keep it somewhere you will still have it',
			'in a year.',
			'',
		].join('\n');

		saveBlob(new Blob([body], { type: 'text/plain' }), 'premovedprep-recovery-code.txt');
	}

	continue(): void {
		if (!this.canContinue()) {
			return;
		}
		this.router.navigateByUrl('/verify-email', { state: { email: this.email() } });
	}
}
