import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { CollectionSummary } from '../models/collection.model';
import { CollectionApiService } from '../services/collection-api.service';
import { LocalFolderCollection } from './agent.models';
import { LocalShelfService } from './local-shelf.service';
import { CollectionMirrorService } from '../sync/collection-mirror.service';

const DEFAULT_ICON = 'folder';

@Injectable({ providedIn: 'root' })
export class LocalSyncService {
	private readonly shelf = inject(LocalShelfService);
	private readonly api = inject(CollectionApiService);
	private readonly mirror = inject(CollectionMirrorService);

	async push(local: LocalFolderCollection): Promise<number> {
		const created = await firstValueFrom(
			this.api.create(local.kind, local.name, local.icon || DEFAULT_ICON, local.color, false),
		);
		await this.shelf.pair(local.id, created.id);

		const copied = await this.mirror.sync({ ...local, cloudId: created.id, syncedDigest: null }, 'push');
		if (!copied) {
			throw new Error(
				`"${local.name}" was paired with the cloud, but its games could not be copied yet. They will be copied the next time the cloud is reachable.`,
			);
		}
		return created.id;
	}

	async pull(cloud: CollectionSummary): Promise<string> {
		const written = await this.shelf.adopt({
			kind: cloud.kind,
			color: cloud.color,
			name: cloud.name,
			pgn: '',
			cloudId: cloud.id,
			icon: cloud.icon,
		});
		const copied = await this.mirror.sync(
			{
				id: written.id,
				kind: cloud.kind,
				color: cloud.color,
				name: written.name,
				updatedAt: new Date(0).toISOString(),
				cloudId: cloud.id,
				syncedDigest: null,
			},
			'pull',
		);
		if (!copied) {
			// A half-written file could be mistaken by the next sync for the older side of a pair.
			await this.shelf.remove(written.id).catch(() => undefined);
			throw new Error(`"${cloud.name}" could not be copied to this computer. Try again when the cloud is reachable.`);
		}
		return written.id;
	}

	// Best effort: a file already renamed/moved locally must not fail a cloud edit already applied.
	async followCloudEdit(
		cloudId: number,
		name: string,
		icon: string,
		shelf: readonly LocalFolderCollection[],
	): Promise<void> {
		const twin = shelf.find((collection) => collection.cloudId === cloudId);
		if (!twin) {
			return;
		}

		if (twin.icon !== icon) {
			try {
				await this.shelf.setIcon(twin.id, icon);
			} catch {
				// Cosmetic; the next sync retries.
			}
		}

		if (twin.name !== name) {
			try {
				await this.shelf.rename(twin.id, name);
			} catch {
				// Cosmetic; the next sync retries.
			}
		}
	}
}
