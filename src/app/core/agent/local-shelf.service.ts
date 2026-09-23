import { Injectable, inject } from '@angular/core';
import { AgentBridgeService } from './agent-bridge.service';
import { CollectionKind, RepertoireColor } from '../models/collection.model';
import { LocalFolderCollection, LocalFolderEntry, LocalFolderEntryDetail } from './agent.models';
import { CollectionSummary, ItemDetail, ItemType } from '../models/collection.model';
import { RepertoireTree } from '../models/repertoire.model';
import { CollectionChangesService } from '../sync/collection-changes.service';

@Injectable({ providedIn: 'root' })
export class LocalShelfService {
	private readonly bridge = inject(AgentBridgeService);
	private readonly changes = inject(CollectionChangesService);

	available(): boolean {
		return this.bridge.connected();
	}

	async shelf(kind: CollectionKind, color: RepertoireColor | null): Promise<readonly LocalFolderCollection[]> {
		if (!this.available()) {
			return [];
		}
		try {
			return await this.bridge.request<LocalFolderCollection[]>('folder.shelf', {
				kind,
				color: kind === 'REPERTOIRE' ? (color ?? 'w') : null,
			});
		} catch {
			return [];
		}
	}

	async collection(kind: CollectionKind, id: string): Promise<LocalFolderCollection | null> {
		const shelves: (RepertoireColor | null)[] = kind === 'REPERTOIRE' ? ['w', 'b'] : [null];

		for (const color of shelves) {
			const found = (await this.shelf(kind, color)).find((collection) => collection.id === id);
			if (found) {
				return found;
			}
		}
		return null;
	}

	async create(
		kind: CollectionKind,
		color: RepertoireColor | null,
		name: string,
	): Promise<LocalFolderCollection> {
		return this.bridge.request<LocalFolderCollection>('folder.create', {
			kind,
			color: kind === 'REPERTOIRE' ? (color ?? 'w') : null,
			name,
		});
	}

	async entries(collectionId: string): Promise<readonly LocalFolderEntry[]> {
		if (!this.available()) {
			return [];
		}
		try {
			return await this.bridge.request<LocalFolderEntry[]>('folder.entries', { collectionId });
		} catch {
			return [];
		}
	}

	async entry(id: string): Promise<LocalFolderEntryDetail> {
		return this.bridge.request<LocalFolderEntryDetail>('folder.entry', { id });
	}

	async details(collectionId: string): Promise<readonly LocalFolderEntryDetail[]> {
		if (!this.available()) {
			return [];
		}
		try {
			return await this.bridge.request<LocalFolderEntryDetail[]>('folder.details', { collectionId });
		} catch {
			return [];
		}
	}

	// Throws on failure, unlike details(): an empty read must not sync as an empty collection.
	async detailsOrFail(collectionId: string): Promise<readonly LocalFolderEntryDetail[]> {
		return this.bridge.request<LocalFolderEntryDetail[]>('folder.details', { collectionId });
	}

	async repertoireTree(entryId: string): Promise<RepertoireTree | null> {
		const [collectionId, at] = String(entryId).split('#');
		const index = Number(at);
		if (!Number.isInteger(index)) {
			return null;
		}

		const entries = await this.details(collectionId);
		const trunk = entries[index];
		if (!trunk || trunk.itemType !== 'MAIN_LINE') {
			return null;
		}

		const { buildRepertoireTree } = await import('../repertoire/repertoire-linker');
		const items = entries.map((entry, at) => asItemDetail(entry, at));

		const tree = buildRepertoireTree(items[index], asCollectionSummary(trunk), items);
		return { ...tree, localCollectionId: collectionId };
	}

	// ids are negative, unique across files; must never collide with a cloud id (never negative).
	async trunks(color: RepertoireColor, cloudIds: ReadonlySet<number>): Promise<ItemDetail[]> {
		const files = (await this.shelf('REPERTOIRE', color)).filter(
			(file) => file.cloudId === null || !cloudIds.has(file.cloudId),
		);

		const trunks: ItemDetail[] = [];
		for (const file of files) {
			const entries = await this.details(file.id);
			entries.forEach((entry, at) => {
				if (entry.itemType === 'MAIN_LINE') {
					trunks.push({ ...asItemDetail(entry, at), id: -(trunks.length + 1) });
				}
			});
		}
		return trunks;
	}

	async read(collectionId: string): Promise<string | null> {
		return this.bridge.request<string | null>('folder.read', { collectionId });
	}

	async adopt(params: {
		kind: CollectionKind;
		color: RepertoireColor | null;
		name: string;
		pgn: string;
		cloudId: number | null;
		icon?: string;
	}): Promise<{ id: string; name: string }> {
		return this.bridge.request<{ id: string; name: string }>('folder.adopt', { ...params });
	}

	async setIcon(collectionId: string, icon: string): Promise<void> {
		await this.bridge.request<boolean>('folder.icon', { collectionId, icon });
	}

	async append(
		collectionId: string,
		pgn: string,
		stamp: { itemType?: string; title?: string } = {},
	): Promise<{ added: number; total: number }> {
		const result = await this.bridge.request<{ added: number; total: number }>('folder.append', {
			collectionId,
			pgn,
			...stamp,
		});
		this.changes.local(collectionId);
		return result;
	}

	async replaceEntry(id: string, pgn: string): Promise<boolean> {
		const result = await this.bridge.request<boolean>('folder.entryReplace', { id, pgn });
		this.changes.local(id);
		return result;
	}

	async removeEntry(id: string): Promise<boolean> {
		const result = await this.bridge.request<boolean>('folder.entryRemove', { id });
		this.changes.local(id);
		return result;
	}

	// No changes.local(): this is the mirror's own write, and notifying it would be a no-op diff.
	async write(collectionId: string, pgn: string): Promise<void> {
		await this.bridge.request<boolean>('folder.write', { collectionId, pgn });
	}

	async markSynced(collectionId: string, digest: string | null): Promise<void> {
		await this.bridge.request<boolean>('folder.synced', { collectionId, digest });
	}

	async rename(collectionId: string, name: string): Promise<{ id: string; name: string }> {
		return this.bridge.request<{ id: string; name: string }>('folder.rename', { collectionId, name });
	}

	async remove(collectionId: string): Promise<boolean> {
		return this.bridge.request<boolean>('folder.remove', { collectionId });
	}

	async pair(collectionId: string, cloudId: number | null): Promise<boolean> {
		return this.bridge.request<boolean>('folder.pair', { collectionId, cloudId });
	}
}

// id is the entry's position in the file; the linker only needs ids distinct within one file.
function asItemDetail(entry: LocalFolderEntryDetail, at: number): ItemDetail {
	return {
		id: at,
		collectionId: 0,
		itemType: entry.itemType as ItemType,
		shape: entry.shape,
		sortOrder: at,
		title: entry.title,
		author: entry.author,
		white: entry.white,
		whiteElo: entry.whiteElo,
		black: entry.black,
		blackElo: entry.blackElo,
		result: entry.result,
		event: entry.event,
		date: entry.date,
		year: entry.year,
		eco: entry.eco,
		plyCount: entry.plyCount,
		startFen: entry.startFen,
		updatedAt: entry.updatedAt,
		createdAt: entry.updatedAt,
		pgn: entry.pgn,
	};
}

function asCollectionSummary(entry: LocalFolderEntryDetail): CollectionSummary {
	return {
		id: 0,
		kind: entry.kind,
		color: entry.color,
		name: entry.collectionName,
		icon: 'folder',
		sortOrder: 0,
		itemCount: 0,
		updatedAt: entry.updatedAt,
	};
}
