import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PlanLock } from '../../core/services/plan-access.service';
import { SignedOutNoticeComponent } from '../signed-out/signed-out-notice.component';
import { PawnLogoComponent } from '../logo/pawn-logo.component';
import { KnightLogoComponent } from '../logo/knight-logo.component';
import { BishopLogoComponent } from '../logo/bishop-logo.component';
import { RookLogoComponent } from '../logo/rook-logo.component';
import { RoyalLogoComponent } from '../logo/royal-logo.component';

export interface LockedPage {
	readonly mark: 'pawn' | 'knight' | 'bishop' | 'rook' | 'royal';
	readonly title: string;
	readonly description: string;
}

@Component({
	selector: 'app-plan-required-notice',
	standalone: true,
	imports: [
		RouterLink,
		SignedOutNoticeComponent,
		PawnLogoComponent,
		KnightLogoComponent,
		BishopLogoComponent,
		RookLogoComponent,
		RoyalLogoComponent,
	],
	template: `
		<header class="intro">
			@switch (page().mark) {
				@case ('pawn') {
					<app-pawn-logo class="mark"></app-pawn-logo>
				}
				@case ('knight') {
					<app-knight-logo class="mark"></app-knight-logo>
				}
				@case ('bishop') {
					<app-bishop-logo class="mark"></app-bishop-logo>
				}
				@case ('rook') {
					<app-rook-logo class="mark"></app-rook-logo>
				}
				@case ('royal') {
					<app-royal-logo class="mark"></app-royal-logo>
				}
			}
			<div>
				<h1>{{ page().title }}</h1>
				<p class="lead">{{ page().description }}</p>
			</div>
		</header>

		@switch (lock()) {
			@case ('signed-out') {
				<app-signed-out-notice />
			}
			@case ('checking') {}
			@case ('preview') {
				<div class="signed-out">
					<p class="headline">Early access only.</p>
					<p class="detail">
						The application is open to early access accounts for now. Check out
						<a routerLink="/plan">Subscription Plan</a> for more.
					</p>
				</div>
			}
			@case ('unverified') {
				<div class="signed-out">
					<p class="headline">Your plan could not be checked.</p>
					<p class="detail">
						Connect to the internet so the application can confirm your
						<a routerLink="/plan">Subscription Plan</a>.
					</p>
				</div>
			}
			@default {
				<div class="signed-out">
					<p class="headline">Premoved plan required.</p>
					<p class="detail">Check out <a routerLink="/plan">Subscription Plan</a> to access all features.</p>
				</div>
			}
		}
	`,
	styles: `
		:host {
			display: block;
			padding: 28px 32px 48px;
			color: var(--text-main);
		}

		.intro {
			display: flex;
			gap: 1.1rem;
			align-items: flex-start;
			margin-bottom: 24px;
		}

		.intro .mark {
			width: 3.75rem;
			height: 3.75rem;
			flex-shrink: 0;
		}

		h1 {
			margin: 0;
			font-size: 1.35rem;
			font-weight: 600;
			color: var(--text-strong);
		}

		.lead {
			margin: 0.35rem 0 0;
			max-width: 34rem;
			font-size: 0.9rem;
			line-height: 1.6;
			color: var(--text-muted);
		}

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
export class PlanRequiredNoticeComponent {
	readonly lock = input.required<PlanLock>();
	readonly page = input.required<LockedPage>();
}
