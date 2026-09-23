import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { KdfParameters, deriveFromPassword } from './kdf';
import { VaultService } from './vault.service';
import { writePayload } from '../services/item-payload';
import { ItemType } from '../models/collection.model';

// Client-side, once, after a legacy sign-in: only the browser has the password to derive the key.
@Injectable({ providedIn: 'root' })
export class VaultMigrationService {
	private readonly http = inject(HttpClient);
	private readonly vault = inject(VaultService);
	private readonly baseUrl = environment.apiBaseUrl;

	private readonly _remaining = signal<number | null>(null);

	readonly remaining = this._remaining.asReadonly();

	readonly running = computed(() => this._remaining() !== null);

	async adopt(email: string, password: string, kdf: KdfParameters, userId: number): Promise<void> {
		try {
			const created = await this.vault.create(password, email, kdf);
			const derived = await deriveFromPassword(password, email, kdf);

			await firstValueFrom(
				this.http.post<void>(
					`${this.baseUrl}/vault/adopt`,
					{ currentPassword: password, authSecret: created.authSecret, vault: created.material },
					{ withCredentials: true },
				),
			);

			await this.vault.adoptCreated(created, derived.vaultKey, userId);
			await this.sealEverything();
		} catch (error) {
			// Reported and swallowed: the person is signed in regardless, and migration retries next time.
			this._remaining.set(null);
			console.error('This account could not be moved to encrypted storage; it will be retried', error);
		}
	}

	// A page at a time, not the whole account, since this runs while someone is waiting to use the
	// application and an account may hold megabytes of PGN.
	async sealEverything(): Promise<void> {
		for (;;) {
			const batch = await this.fetchBatch();
			this._remaining.set(batch.remaining);

			if (batch.items.length === 0 && batch.collections.length === 0) {
				this._remaining.set(null);
				return;
			}

			const collections = await Promise.all(
				batch.collections.map(async (collection) => ({
					collectionId: collection.id,
					nameCipher: await this.vault.seal('collection-name', collection.name),
				})),
			);

			const items: { itemId: number; payload: string }[] = [];
			for (const row of batch.items) {
				items.push({
					itemId: row.id,
					payload: await this.vault.seal('item', writePayload({ pgn: row.pgn, title: row.title, author: row.author })),
				});
			}

			const after = await this.postBatch(items, collections);
			this._remaining.set(after.remaining);

			// No progress: stop rather than ask for the same unsealable page forever.
			if (after.remaining >= batch.remaining && (after.items.length > 0 || after.collections.length > 0)) {
				this._remaining.set(null);
				throw new Error('Some entries could not be moved to encrypted storage');
			}
		}
	}

	private fetchBatch(): Promise<MigrationBatch> {
		return firstValueFrom(this.http.get<MigrationBatch>(`${this.baseUrl}/collections/migration`));
	}

	private postBatch(
		items: readonly { itemId: number; payload: string }[],
		collections: readonly { collectionId: number; nameCipher: string }[],
	): Promise<MigrationBatch> {
		return firstValueFrom(
			this.http.post<MigrationBatch>(`${this.baseUrl}/collections/migration`, { items, collections }),
		);
	}
}

// The only place this API returns a readable PGN: legacy plaintext being carried into encrypted storage.
interface MigrationBatch {
	readonly remaining: number;
	readonly collections: readonly { id: number; name: string }[];
	readonly items: readonly {
		readonly id: number;
		readonly collectionId: number;
		readonly itemType: ItemType;
		readonly sortOrder: number;
		readonly title: string | null;
		readonly author: string | null;
		readonly startFen: string | null;
		readonly pgn: string;
	}[];
}
