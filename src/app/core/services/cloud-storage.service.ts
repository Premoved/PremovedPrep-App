import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { StorageUsage } from '../models/collection.model';
import { CollectionApiService } from './collection-api.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import { ApiError } from '../interceptors/error.interceptor';

// bytesQuota is the figure shown to the user; bytesHardLimit is where writes actually stop.
@Injectable({ providedIn: 'root' })
export class CloudStorageService {
	private readonly api = inject(CollectionApiService);
	private readonly auth = inject(AuthService);
	private readonly notify = inject(NotificationService);
	private readonly router = inject(Router);

	private readonly _usage = signal<StorageUsage | null>(null);

	readonly usage = this._usage.asReadonly();

	readonly percent = computed(() => {
		const usage = this._usage();
		return usage && usage.bytesQuota > 0 ? (usage.bytesUsed / usage.bytesQuota) * 100 : 0;
	});

	// Only the cloud path consults this; a PGN kept in the browser is not bounded by it.
	readonly maxRequestBytes = computed(() => this._usage()?.bytesMaxRequest ?? null);

	readonly overQuota = computed(() => {
		const usage = this._usage();
		return usage !== null && usage.bytesUsed > usage.bytesQuota;
	});

	constructor() {
		effect(() => {
			if (this.auth.isLoggedIn()) {
				untracked(() => this.refresh());
			} else {
				this._usage.set(null);
			}
		});
	}

	refresh(): void {
		if (!this.auth.isLoggedIn()) {
			return;
		}
		this.api.storage().subscribe({
			next: (usage) => {
				this._usage.set(usage);
			},
			error: () => undefined,
		});
	}

	reportFull(error: unknown): boolean {
		if (!(error instanceof ApiError) || error.status !== 507) {
			return false;
		}

		const usage = usageFrom(error);
		if (usage) {
			// The 507 body lacks the policy figure; keep the previous value.
			this._usage.set({ ...usage, bytesMaxRequest: this._usage()?.bytesMaxRequest });
		} else {
			this.refresh();
		}

		this.notify.error(error.message);
		void this.router.navigate(['/'], { fragment: 'account' });
		return true;
	}
}

function usageFrom(error: ApiError): StorageUsage | null {
	const problem = error.problem;
	if (!problem) {
		return null;
	}
	const used = problem['bytesUsed'];
	const quota = problem['bytesQuota'];
	const hard = problem['bytesHardLimit'];
	if (typeof used !== 'number' || typeof quota !== 'number' || typeof hard !== 'number') {
		return null;
	}
	return { bytesUsed: used, bytesQuota: quota, bytesHardLimit: hard };
}
