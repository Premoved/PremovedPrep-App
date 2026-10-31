import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiError } from '../interceptors/error.interceptor';
import { CollectionSummary } from '../models/collection.model';
import { CollectionApiService } from '../services/collection-api.service';
import { AgentError, LocalFolderCollection } from './agent.models';
import { LocalShelfService } from './local-shelf.service';
import { CollectionMirrorService } from '../sync/collection-mirror.service';

const DEFAULT_ICON = 'folder';

// What Windows answers when another program (ChessBase, an editor) holds the file open.
const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

@Injectable({ providedIn: 'root' })
export class LocalSyncService {
	private readonly shelf = inject(LocalShelfService);
	private readonly api = inject(CollectionApiService);
	private readonly mirror = inject(CollectionMirrorService);

	// All or nothing: either the file ends up paired with a cloud copy holding its games, or the
	// cloud is left as it was and the file unpaired, so the button can simply be pressed again.
	async push(local: LocalFolderCollection): Promise<number> {
		// The card may be older than the file: a pairing made since is reused, not doubled.
		const current = (await this.shelf.collection(local.kind, local.id)) ?? local;
		if (current.cloudId !== null && (await this.cloudExists(current.cloudId))) {
			const copied = await this.mirror.sync({ ...current, syncedDigest: null }, 'push');
			if (!copied) {
				throw new Error(
					`"${local.name}" is already paired with the cloud, but its games could not be copied. Try again.`,
				);
			}
			return current.cloudId;
		}

		try {
			await this.mirror.stampUids(local.id);
		} catch (error) {
			throw this.explain(local, error);
		}

		const created = await firstValueFrom(
			this.api.create(local.kind, local.name, local.icon || DEFAULT_ICON, local.color, false),
		);
		try {
			await this.shelf.pair(local.id, created.id);
			const copied = await this.mirror.sync({ ...local, cloudId: created.id, syncedDigest: null }, 'push');
			if (!copied) {
				throw new Error(`"${local.name}" could not be copied to the cloud. Nothing was changed; try again.`);
			}
		} catch (error) {
			await this.undoPush(local.id, created.id);
			throw this.explain(local, error);
		}
		return created.id;
	}

	// Unpaired first, so the removal below cannot be mirrored back onto the file.
	private async undoPush(localId: string, cloudId: number): Promise<void> {
		await this.shelf.pair(localId, null).catch(() => undefined);
		await firstValueFrom(this.api.remove(cloudId)).catch(() => undefined);
	}

	private async cloudExists(cloudId: number): Promise<boolean> {
		try {
			await firstValueFrom(this.api.get(cloudId));
			return true;
		} catch (error) {
			if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
				return false;
			}
			throw error;
		}
	}

	private explain(local: LocalFolderCollection, error: unknown): Error {
		if (error instanceof AgentError && LOCKED_CODES.has(error.code)) {
			return new Error(
				`"${local.name}" is open in another program (ChessBase, for example). Close it there and try again.`,
			);
		}
		return error instanceof Error ? error : new Error(String(error));
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
