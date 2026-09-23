import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
	selector: 'app-database-icon',
	standalone: true,
	imports: [],
	template: `
		@if (cloud()) {
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
				<!-- Boxicons v3.0.8 - https://boxicons.com -->
				<path
					d="M19.62 11.11C19.19 7.12 15.94 4 12 4 8.95 4 6.31 5.87 5.13 8.82 2.77 9.53 1 11.85 1 14.33 1 17.45 3.44 20 6.44 20h12.22c2.39 0 4.33-2.02 4.33-4.5 0-2.14-1.45-3.94-3.38-4.39ZM18.67 18H6.44C4.54 18 3 16.35 3 14.33c0-1.72 1.38-3.37 3.07-3.68l.58-.11.19-.56C7.64 7.53 9.62 6 12 6c3.12 0 5.67 2.69 5.67 6v1h1c1.29 0 2.33 1.12 2.33 2.5S19.95 18 18.67 18"
				/>
			</svg>
		} @else {
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
				<!-- Boxicons v3.0.8 - https://boxicons.com -->
				<path
					d="M12 2C7.66 2 4 3.83 4 6v12c0 2.17 3.66 4 8 4s8-1.83 8-4V6c0-2.17-3.66-4-8-4m0 2c3.68 0 5.91 1.49 6 2-.09.51-2.32 2-6 2S6.07 6.49 6 6.01C6.07 5.51 8.31 4 12 4M6 8.61C7.48 9.46 9.64 10 12 10s4.52-.55 6-1.39V10c-.07.5-2.31 2-6 2s-5.93-1.51-6-2zm0 4c1.48.85 3.64 1.39 6 1.39s4.52-.55 6-1.39V14c-.07.5-2.31 2-6 2s-5.93-1.51-6-2zM12 20c-3.69 0-5.93-1.51-6-2v-1.39c1.48.85 3.64 1.39 6 1.39s4.52-.55 6-1.39V18c-.07.5-2.31 2-6 2"
				/>
			</svg>
		}
	`,
	styles: [
		`
			:host {
				display: inline-flex;
				flex: 0 0 auto;
				color: var(--text-muted);
			}

			svg {
				width: 0.95rem;
				height: 0.95rem;
			}
		`,
	],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DatabaseIconComponent {
	readonly cloud = input.required<boolean>();
}
