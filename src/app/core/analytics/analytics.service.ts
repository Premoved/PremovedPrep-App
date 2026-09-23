import { Injectable } from '@angular/core';
import { AnalyticsEventName } from './analytics.events';

type Props = Record<string, unknown>;

// Structurally off, not just unconfigured: no vendor script, endpoint or key ships in the bundle,
// so the "no analytics" claim in the privacy notice can be verified from the served JS itself.
@Injectable({ providedIn: 'root' })
export class AnalyticsService {
	init(): void {
		// Analytics disabled: no-op.
	}

	identify(userId: number | string, properties?: Props): void {
		void userId;
		void properties;
	}

	reset(): void {
		// Analytics disabled: no-op.
	}

	capture(event: AnalyticsEventName, properties?: Props): void {
		void event;
		void properties;
	}
}
