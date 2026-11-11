import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Block, parseNotices } from './markdown-notices';

/** Renders licenses/THIRD-PARTY.md, which the build copies into the folder the shell serves, as a page rather than raw Markdown. */
@Component({
	selector: 'app-third-party',
	standalone: true,
	imports: [NgTemplateOutlet],
	templateUrl: './third-party.component.html',
	styleUrl: './legal-page.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThirdPartyComponent {
	readonly notices = signal<readonly Block[] | null>(null);
	readonly failed = signal(false);

	constructor() {
		inject(HttpClient)
			.get('/licenses/THIRD-PARTY.md', { responseType: 'text' })
			.subscribe({
				next: (text) => this.notices.set(parseNotices(text)),
				error: () => this.failed.set(true),
			});
	}
}
