import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiError } from '../interceptors/error.interceptor';
import { isUnreachable } from '../browser/offline';
import { CollectionSummary } from '../models/collection.model';
import { CollectionApiService } from '../services/collection-api.service';
import { AgentError, LocalFolderCollection } from './agent.models';
import { LocalShelfService } from './local-shelf.service';
import { CollectionMirrorService } from '../sync/collection-mirror.service';

const DEFAULT_ICON = 'folder';

// Renames and icon changes made to a paired file while its cloud twin could not be reached, by
// cloud id: sent when the connection is back. The latest change for a collection replaces earlier ones.
const PENDING_EDITS_KEY = 'premovedprep.pendingCloudEdits';

interface PendingEdit {
	readonly name: string;
	readonly icon: string;
}

// What Windows answers when another program (ChessBase, an editor) holds the file open.
const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

@Injectable({ providedIn: 'root' })
export class LocalSyncService {
	private readonly shelf = inject(LocalShelfService);
	private readonly api = inject(CollectionApiService);
	private readonly mirror = inject(CollectionMirrorService);

	constructor() {
		window.addEventListener('online', () => void this.sendPendingEdits());
	}

	/**
	 * A rename or icon change made on this computer, followed by the cloud twin. Without a
	 * connection it is kept and sent later, and this answers false; any other refusal is thrown.
	 */
	async followLocalEdit(cloudId: number, name: string, icon: string): Promise<boolean> {
		try {
			await firstValueFrom(this.api.update(cloudId, { name, icon }));
			setPendingEdit(cloudId, null);
			return true;
		} catch (error) {
			if (isUnreachable(error)) {
				setPendingEdit(cloudId, { name, icon });
				return false;
			}
			throw error;
		}
	}

	async sendPendingEdits(): Promise<void> {
		for (const [cloudId, edit] of Object.entries(readPendingEdits())) {
			try {
				await firstValueFrom(this.api.update(Number(cloudId), edit));
				setPendingEdit(Number(cloudId), null);
			} catch (error) {
				// Gone from the cloud, or no longer this account's: nothing left to rename.
				if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
					setPendingEdit(Number(cloudId), null);
				}
				// Otherwise kept for the next try.
			}
		}
	}

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
			const removed = await this.undoPush(local.id, created.id);
			const explained = this.explain(local, error);
			if (!removed) {
				explained.message += ` An empty "${local.name}" may be left in the cloud: delete it there.`;
			}
			throw explained;
		}
		return created.id;
	}

	// Unpaired first, so the removal below cannot be mirrored back onto the file. False when the
	// empty cloud copy could not be removed (the connection dropped half-way).
	private async undoPush(localId: string, cloudId: number): Promise<boolean> {
		await this.shelf.pair(localId, null).catch(() => undefined);
		try {
			await firstValueFrom(this.api.remove(cloudId));
			return true;
		} catch {
			return false;
		}
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
			throw new Error(`"${cloud.name}" could not be copied to this device. Try again when the cloud is reachable.`);
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

function readPendingEdits(): Record<string, PendingEdit> {
	try {
		const stored = JSON.parse(localStorage.getItem(PENDING_EDITS_KEY) ?? '{}') as unknown;
		return stored !== null && typeof stored === 'object' ? (stored as Record<string, PendingEdit>) : {};
	} catch {
		return {};
	}
}

function setPendingEdit(cloudId: number, edit: PendingEdit | null): void {
	const pending = readPendingEdits();
	if (edit === null) {
		if (!(cloudId in pending)) {
			return;
		}
		delete pending[cloudId];
	} else {
		pending[cloudId] = edit;
	}
	try {
		localStorage.setItem(PENDING_EDITS_KEY, JSON.stringify(pending));
	} catch {
		// Storage unavailable: the change stays on this computer only.
	}
}
