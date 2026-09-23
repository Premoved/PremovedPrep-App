import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ArchiveNameService } from '../../core/services/archive-name.service';
import { DatabaseIconComponent } from './database-icon.component';

@Component({
	selector: 'app-database-badge',
	standalone: true,
	imports: [DatabaseIconComponent],
	template: `
		<span class="badge" [title]="title()">
			<span class="name">{{ archive.inUse().name }}</span>
			<app-database-icon [cloud]="archive.inUse().cloud" />
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
		return choice.cloud ? `${choice.name} — in the cloud` : (choice.path ?? choice.name);
	}
}
