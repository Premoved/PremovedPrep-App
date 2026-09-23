import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

// The clauses a buyer has to be able to read before paying. Same wording as the matching
// sections of the Terms and Conditions; the website shows this component on its Desktop App page.
@Component({
	selector: 'app-plan-terms',
	standalone: true,
	imports: [RouterLink],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
		<section class="plan-terms">
			<h2>Plan terms</h2>

			<h3>The Premoved Plan</h3>
			<p>
				An active plan opens the Desktop App's tools and raises the cloud storage allowance to 5 MB. A plan is active
				while a free trial runs, while a paid subscription runs, or while access has been granted to the account.
			</p>

			<h3>Prices and payment</h3>
			<p>
				The subscription is &euro;1.24 per month or &euro;11.99 per year. Prices are in euro and include VAT where it
				applies; the amount payable is shown before the payment is confirmed. Payment is processed by Stripe, which
				issues the receipt; card details are handled by Stripe and are never received or stored here. The contract is
				concluded in English, at the moment the payment succeeds, and accepting the Terms and Conditions is part of that
				payment.
			</p>

			<h3>Renewal and price changes</h3>
			<p>
				A subscription renews automatically at the end of each paid period and is charged to the payment method held by
				Stripe. A change of price is announced by email at least 30 days before it takes effect, and the subscription
				can be cancelled before then. If a renewal payment fails, the plan stays active until the end of the period
				already paid for, and then ends.
			</p>

			<h3>Free trial</h3>
			<p>
				A free trial of 14 days is available once per account, and is not offered to an account that has already held
				the plan. It needs no bank details and does not become a paid subscription by itself.
			</p>

			<h3>Cancellation, and the end of a plan</h3>
			<p>
				A subscription can be cancelled at any time, from the Subscription Plan page in the Desktop App or from the
				Desktop App page on the website, and it stays active until the end of the period already paid for. When a plan
				ends, the Desktop App's tools close and the cloud storage allowance returns to the free 2 MB. Nothing is
				deleted: files already in the cloud stay readable and can be downloaded, and while they exceed the free
				allowance no new files can be saved to the cloud until they are brought under it.
			</p>

			<h3>Right of withdrawal, and refunds</h3>
			<p>
				A consumer in the European Union has 14 days to withdraw from a contract for a digital service. That right ends
				earlier if the service is asked to start at once and the loss of the right is acknowledged at that moment. For a
				first subscription, no such acknowledgement is asked for: cancelling within 14 days of the account's first
				payment ends the plan at once and the payment is refunded in full, automatically, to the payment method it was
				made from. This applies once per account. After a refund has been granted, a further subscription on the same
				account can only be started by asking for the plan to begin at once and acknowledging, at the checkout, that the
				right of withdrawal is lost when it does; no further automatic refund is granted. A withdrawal can also be
				declared by writing to
				<a href="mailto:contact@premoved.com">contact&#64;premoved.com</a> within 14 days.
			</p>

			<p class="full">
				These are the clauses about the plan. The full
				<a routerLink="/terms">Terms and Conditions</a> and the <a routerLink="/privacy">Privacy Policy</a> apply to the
				whole service.
			</p>
		</section>
	`,
	styles: `
		.plan-terms {
			margin-top: 2rem;
			padding-top: 1.5rem;
			border-top: 1px solid var(--bg-border);
			color: var(--text-muted);
			font-size: 0.85rem;
			line-height: 1.55;
		}

		h2 {
			margin: 0 0 1rem;
			font-size: 1.05rem;
			font-weight: 700;
			color: var(--text-strong-muted);
		}

		h3 {
			margin: 1.1rem 0 0.35rem;
			font-size: 0.9rem;
			font-weight: 600;
			color: var(--text-main);
		}

		p {
			margin: 0;
			max-width: 60rem;
		}

		a {
			color: inherit;
			text-decoration: underline;
		}

		.full {
			margin-top: 1.25rem;
		}
	`,
})
export class PlanTermsComponent {}
