import {
	ChangeDetectionStrategy,
	Component,
	DestroyRef,
	HostListener,
	computed,
	effect,
	inject,
	signal,
	untracked,
} from '@angular/core';
import { NavigationStart, Router, RouterLink } from '@angular/router';
import { DesktopService } from '../../core/shell/desktop.service';
import { AuthService } from '../../core/services/auth.service';
import { BillingService } from '../../core/services/billing.service';
import { PlanAccessService } from '../../core/services/plan-access.service';
import { PlanInterval, SubscriptionView } from '../../core/models/user.model';
import { PlanIconComponent } from '../../shared/logo/plan-icon.component';
import { ApiError } from '../../core/interceptors/error.interceptor';

interface PlanLine {
	readonly label: string;
	readonly detail: string | null;
	readonly tone: 'on' | 'off';
}

interface Showcase {
	readonly title: string;
	readonly text: string;
	readonly image: string;
}

const KEPT_VIEW_KEY = 'premovedprep.planView';

// Minor units: 124 = EUR 1.24.
const DEFAULT_PRICES = { monthly: 124, yearly: 1199, currency: 'EUR' };

@Component({
	selector: 'app-plan-page',
	standalone: true,
	imports: [RouterLink, PlanIconComponent],
	templateUrl: './plan-page.component.html',
	styleUrl: './plan-page.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanPageComponent {
	readonly auth = inject(AuthService);
	private readonly billing = inject(BillingService);
	private readonly access = inject(PlanAccessService);

	readonly view = signal<SubscriptionView | null>(null);
	readonly busy = signal<PlanInterval | 'portal' | 'trial' | null>(null);
	readonly actionFailure = signal<string | null>(null);
	readonly waiverAccepted = signal(false);

	// Free for this account: the page shows what is included and never a price.
	readonly complimentary = computed(() => this.view()?.complimentary === true);

	readonly monthly = computed(() => this.price(this.view()?.monthlyPriceMinor ?? DEFAULT_PRICES.monthly));
	readonly yearly = computed(() => this.price(this.view()?.yearlyPriceMinor ?? DEFAULT_PRICES.yearly));

	readonly saving = computed(() => {
		const monthly = this.view()?.monthlyPriceMinor ?? DEFAULT_PRICES.monthly;
		const yearly = this.view()?.yearlyPriceMinor ?? DEFAULT_PRICES.yearly;
		const percent = Math.floor((1 - yearly / (monthly * 12)) * 100);
		return percent > 0 ? percent : null;
	});

	readonly onTrial = computed(() => {
		const view = this.view();
		return (
			view !== null &&
			view.active &&
			view.renewsAt === null &&
			view.trialEndsAt !== null &&
			new Date(view.trialEndsAt).getTime() > Date.now()
		);
	});

	readonly subscribed = computed(() => (this.view()?.active ?? false) && !this.onTrial());

	readonly canSubscribe = computed(() => (this.view()?.selling ?? false) && !this.subscribed());

	readonly waiverOk = computed(() => this.view()?.waiverRequired !== true || this.waiverAccepted());

	readonly line = computed<PlanLine | null>(() => {
		if (!this.auth.isLoggedIn()) {
			return null;
		}
		const view = this.view();
		if (!view) {
			return { label: 'Unknown', detail: null, tone: 'off' };
		}
		if (this.onTrial() && view.trialEndsAt) {
			return { label: 'Free trial', detail: `ends on ${this.day(view.trialEndsAt)}`, tone: 'on' };
		}
		if (!view.active) {
			return { label: 'No plan', detail: null, tone: 'off' };
		}
		if (!view.renewsAt) {
			return { label: 'Active plan', detail: null, tone: 'on' };
		}
		const ending = view.cancelAtPeriodEnd || view.status === 'CANCELED';
		return {
			label: 'Active plan',
			detail: `${ending ? 'ends on' : 'renews automatically on'} ${this.day(view.renewsAt)}`,
			tone: 'on',
		};
	});

	readonly showcase: readonly Showcase[] = [
		{
			title: 'Local Resources',
			text: 'Select a local folder for saving your collections, use Stockfish or any other UCI engine you add, and index any local PGN databases on your own computer.',
			image: 'plan/local-resources.webp',
		},
		{
			title: 'Cloud and local, kept in sync',
			text: 'All your collections in one place. Choose which collections to keep in cloud, which to keep on your own computer, and which to keep synced between both.',
			image: 'plan/collections.webp',
		},
		{
			title: 'Search your local databases offline',
			text: 'Use the advanced search by multiple criteria to query your local databases any time.',
			image: 'plan/database-search.webp',
		},
		{
			title: 'Advanced Report',
			text: 'Power your Advanced Reports and Search Opponent functions, using any selected local database and the main lines from all your repertoire collections.',
			image: 'plan/advanced-report.webp',
		},
		{
			title: 'Access the cloud resources any time',
			text: "Use any setup you like and query the site's cloud database any time",
			image: 'plan/analysis-board.webp',
		},
	];

	readonly zoomed = signal<number | null>(null);
	private readonly desktop = inject(DesktopService);

	readonly zoomedShot = computed(() => {
		const at = this.zoomed();
		return at === null ? null : this.showcase[at];
	});

	zoom(index: number): void {
		this.zoomed.set(index);
	}

	closeZoom(): void {
		this.zoomed.set(null);
	}

	step(by: number): void {
		const at = this.zoomed();
		if (at !== null) {
			const count = this.showcase.length;
			this.zoomed.set((at + by + count) % count);
		}
	}

	@HostListener('document:keydown', ['$event'])
	onKey(event: KeyboardEvent): void {
		if (this.zoomed() === null) {
			return;
		}
		if (event.key === 'Escape') {
			this.closeZoom();
		} else if (event.key === 'ArrowRight') {
			this.step(1);
		} else if (event.key === 'ArrowLeft') {
			this.step(-1);
		} else {
			return;
		}
		event.preventDefault();
	}

	constructor() {
		effect(() => this.desktop.setDimmed(this.zoomed() !== null));
		const leaving = inject(Router).events.subscribe((event) => {
			if (event instanceof NavigationStart) {
				this.closeZoom();
			}
		});
		inject(DestroyRef).onDestroy(() => {
			leaving.unsubscribe();
			this.desktop.setDimmed(false);
		});
		effect(() => {
			const userId = this.auth.currentUser()?.id ?? null;
			untracked(() => {
				this.view.set(userId === null ? null : recall(userId));
				if (userId !== null) {
					this.load(userId);
				}
			});
		});

		const onVisible = () => {
			const userId = this.auth.currentUser()?.id ?? null;
			if (document.visibilityState === 'visible' && userId !== null) {
				this.load(userId);
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		inject(DestroyRef).onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
	}

	private load(userId: number): void {
		this.access.refresh();
		this.auth.subscription().subscribe({
			next: (view) => {
				// Drops the response if the signed-in account changed while it was in flight.
				if (this.auth.currentUser()?.id !== userId) return;
				this.view.set(view);
				remember(userId, view);
			},
			error: () => {
				// Keep the last known view.
			},
		});
	}

	startTrial(): void {
		this.busy.set('trial');
		this.actionFailure.set(null);
		this.billing.startTrial().subscribe({
			next: (view) => {
				const userId = this.auth.currentUser()?.id;
				this.view.set(view);
				if (userId !== undefined) remember(userId, view);
				this.busy.set(null);
				this.access.refresh();
			},
			error: () => this.fail('The free trial could not be started just now. Please try again in a moment.'),
		});
	}

	subscribe(interval: PlanInterval): void {
		this.busy.set(interval);
		this.actionFailure.set(null);
		this.billing.checkout(interval, this.waiverAccepted()).subscribe({
			next: ({ url }) => this.leaveFor(url),
			error: (err: Error) =>
				this.fail(
					err instanceof ApiError && err.status === 409
						? err.message
						: 'The payment page could not be opened just now. Please try again in a moment.',
				),
		});
	}

	manage(): void {
		this.busy.set('portal');
		this.actionFailure.set(null);
		this.billing.portal().subscribe({
			next: ({ url }) => this.leaveFor(url),
			error: () => this.fail('Your plan could not be opened just now. Please try again in a moment.'),
		});
	}

	private leaveFor(url: string): void {
		window.open(url, '_blank', 'noopener');
		this.busy.set(null);
	}

	private fail(message: string): void {
		this.actionFailure.set(message);
		this.busy.set(null);
	}

	private day(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
	}

	private price(minor: number): string {
		const currency = this.view()?.currency ?? DEFAULT_PRICES.currency;
		return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
	}
}

function recall(userId: number): SubscriptionView | null {
	try {
		const raw = localStorage.getItem(KEPT_VIEW_KEY);
		const kept = raw ? (JSON.parse(raw) as { userId: number; view: SubscriptionView }) : null;
		return kept?.userId === userId ? kept.view : null;
	} catch {
		return null;
	}
}

function remember(userId: number, view: SubscriptionView): void {
	try {
		localStorage.setItem(KEPT_VIEW_KEY, JSON.stringify({ userId, view }));
	} catch {
		// Storage unavailable: nothing is kept.
	}
}
