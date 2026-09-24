import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

/** Renders licenses/THIRD-PARTY.md, which the build copies into the folder the shell serves. */
@Component({
	selector: 'app-third-party',
	standalone: true,
	imports: [],
	templateUrl: './third-party.component.html',
	styleUrl: './legal-page.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThirdPartyComponent {
	readonly notices = signal<string | null>(null);
	readonly failed = signal(false);

	constructor() {
		inject(HttpClient)
			.get('/licenses/THIRD-PARTY.md', { responseType: 'text' })
			.subscribe({
				next: (text) => this.notices.set(text),
				error: () => this.failed.set(true),
			});
	}
}
