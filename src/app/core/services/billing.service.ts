import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { BillingRedirect, PlanInterval, SubscriptionView } from '../models/user.model';

@Injectable({ providedIn: 'root' })
export class BillingService {
	private readonly http = inject(HttpClient);
	private readonly baseUrl = `${environment.apiBaseUrl}/billing`;

	checkout(interval: PlanInterval, waiver = false): Observable<BillingRedirect> {
		return this.http.post<BillingRedirect>(
			`${this.baseUrl}/checkout?interval=${interval}&waiver=${waiver}`,
			{},
			{ withCredentials: true },
		);
	}

	/** Two-week trial, once per account, no card. Returns the updated plan. */
	startTrial(): Observable<SubscriptionView> {
		return this.http.post<SubscriptionView>(`${this.baseUrl}/trial`, {}, { withCredentials: true });
	}

	portal(): Observable<BillingRedirect> {
		return this.http.post<BillingRedirect>(`${this.baseUrl}/portal`, {}, { withCredentials: true });
	}
}
