import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ArchiveNameService } from '../../core/services/archive-name.service';
import { DatabaseIconComponent } from './database-icon.component';

@Component({
	selector: 'app-database-badge',
	standalone: true,
	imports: [DatabaseIconComponent],
	template: `
		<span class="badge" [title]="title()">
			<span class="name">{{ archive.label() }}</span>
			@if (archive.inUse(); as choice) {
				<app-database-icon [cloud]="choice.cloud" />
			}
		</span>
	`,
	styles: [
		`
			.badge {
				display: inline-flex;
				align-items: center;
				gap: 0.35rem;
				min-width: 0;
				color: var(--text-muted);
				font-size: 0.8rem;
			}

			.name {
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
		`,
	],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DatabaseBadgeComponent {
	readonly archive = inject(ArchiveNameService);

	title(): string {
		const choice = this.archive.inUse();
		if (!choice) {
			return 'Choose an indexed database in Local Resources, or sign in to use the Cloud database';
		}
		return choice.cloud ? `${choice.name} — in the cloud` : (choice.path ?? choice.name);
	}
}
