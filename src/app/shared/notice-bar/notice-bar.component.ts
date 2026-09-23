import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NotificationService } from '../../core/services/notification.service';

@Component({
	selector: 'app-notice-bar',
	standalone: true,
	templateUrl: './notice-bar.component.html',
	styleUrl: './notice-bar.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NoticeBarComponent {
	private readonly notifications = inject(NotificationService);

	readonly notices = this.notifications.notices;

	dismiss(id: number): void {
		this.notifications.dismiss(id);
	}
}
