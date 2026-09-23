import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** What the unguarded Library, Repertoire and Desktop agent show to a signed-out visitor. */
@Component({
	selector: 'app-signed-out-notice',
	standalone: true,
	imports: [RouterLink],
	template: `
		<div class="signed-out">
			<p class="headline">You are not signed in.</p>
			<p class="detail">
				<a routerLink="/login">Sign in</a> to access all features
				@if (what()) {
					{{ ' — ' + what() }}
				}
				.
			</p>
		</div>
	`,
	styles: `
		.signed-out {
			padding: 3rem 2rem;
			max-width: 34rem;
		}

		.headline {
			margin: 0;
			font-size: 1.05rem;
			font-weight: 600;
			color: var(--text-strong);
		}

		.detail {
			margin: 0.5rem 0 0;
			font-size: 0.9rem;
			line-height: 1.6;
			color: var(--text-muted);
		}

		.detail a {
			color: var(--glow-blue);
			font-weight: 600;
		}
	`,
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignedOutNoticeComponent {
	/** Brief notice description, or empty for a generic message. */
	readonly what = input('');
}
