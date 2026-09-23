import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, forkJoin, from, map, of, switchMap, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
	CollectionKind,
	CollectionSummary,
	ImportResult,
	ItemDetail,
	ItemRow,
	ItemSortKey,
	ItemSummary,
	ItemType,
	RepertoireColor,
	StorageUsage,
	WireCollectionSummary,
} from '../models/collection.model';
import { RepertoireTree } from '../models/repertoire.model';
import { VaultLockedError, VaultService } from '../crypto/vault.service';
import { convertTypeTo, deriveFields, importTypeFor, parsePgn, shapeOf, splitPgn } from '../chess/pgn-metadata';
import { compareItems } from './item-sort';
import { EMPTY_MAIN_LINE_PGN, ItemPayload, readPayload, writePayload } from './item-payload';
import { buildZip } from '../browser/zip';
import { CollectionChangesService } from '../sync/collection-changes.service';

// Encryption boundary: every PGN and collection name is sealed before sending, opened after receiving.
@Injectable({ providedIn: 'root' })
export class CollectionApiService {
	private readonly http = inject(HttpClient);
	private readonly vault = inject(VaultService);
	// Every write below reports here, which is how a file mirroring the collection learns to follow it.
	private readonly changes = inject(CollectionChangesService);
	private readonly baseUrl = `${environment.apiBaseUrl}/collections`;

	list(kind: CollectionKind, color?: RepertoireColor | null): Observable<CollectionSummary[]> {
		let params = new HttpParams().set('kind', kind);
		if (color) {
			params = params.set('color', color);
		}
		return this.http
			.get<WireCollectionSummary[]>(this.baseUrl, { params })
			.pipe(switchMap((rows) => from(this.openCollections(rows))));
	}

	get(id: number): Observable<CollectionSummary> {
		return this.http
			.get<WireCollectionSummary>(`${this.baseUrl}/${id}`)
			.pipe(switchMap((row) => from(this.openCollection(row))));
	}

	create(
		kind: CollectionKind,
		name: string,
		icon: string,
		color?: RepertoireColor | null,
		// False when importing a file that already holds theory, to avoid seeding an empty main line ahead of it.
		seedTrunk = true,
	): Observable<CollectionSummary> {
		return from(this.newFolderBody(kind, name, icon, color ?? null, seedTrunk)).pipe(
			switchMap((body) => this.http.post<WireCollectionSummary>(this.baseUrl, body)),
			switchMap((row) => from(this.openCollection(row))),
		);
	}

	private async newFolderBody(
		kind: CollectionKind,
		name: string,
		icon: string,
		color: RepertoireColor | null,
		seedTrunk: boolean,
	): Promise<Record<string, unknown>> {
		return {
			kind,
			nameCipher: await this.vault.seal('collection-name', name),
			icon,
			color,
			trunkPayload: kind === 'REPERTOIRE' && seedTrunk ? await this.sealedEmptyTrunk() : null,
		};
	}

	private sealedEmptyTrunk(): Promise<string> {
		return this.sealItem({ pgn: EMPTY_MAIN_LINE_PGN, title: null, author: null });
	}

	update(id: number, changes: { name?: string; icon?: string; sortOrder?: number }): Observable<CollectionSummary> {
		const sealing =
			changes.name === undefined ? Promise.resolve(undefined) : this.vault.seal('collection-name', changes.name);

		return from(sealing).pipe(
			switchMap((nameCipher) =>
				this.http.patch<WireCollectionSummary>(`${this.baseUrl}/${id}`, {
					nameCipher,
					icon: changes.icon,
					sortOrder: changes.sortOrder,
				}),
			),
			switchMap((row) => from(this.openCollection(row))),
		);
	}

	remove(id: number): Observable<void> {
		return this.http.delete<void>(`${this.baseUrl}/${id}`);
	}

	transferCollections(
		kind: CollectionKind,
		color: RepertoireColor | null,
		collectionIds: readonly number[],
		copy: boolean,
	): Observable<CollectionSummary[]> {
		return forkJoin({
			existing: this.list(kind, color),
			sources: forkJoin(collectionIds.map((id) => this.get(id))),
			contents: forkJoin(collectionIds.map((id) => this.listDetails(id))),
		}).pipe(
			switchMap(({ existing, sources, contents }) =>
				from(this.planCollectionTransfer(kind, sources, contents, existing, copy)),
			),
			switchMap((collections) =>
				this.http.post<WireCollectionSummary[]>(`${this.baseUrl}/transfer`, {
					kind,
					color: color ?? null,
					collections,
					copy,
				}),
			),
			switchMap((rows) => from(this.openCollections(rows))),
		);
	}

	listItems(collectionId: number, sort: ItemSortKey, ascending?: boolean): Observable<ItemSummary[]> {
		return this.listDetails(collectionId).pipe(map((items) => sortItems(items, sort, ascending)));
	}

	listDetails(collectionId: number): Observable<ItemDetail[]> {
		return this.http
			.get<ItemRow[]>(`${this.baseUrl}/${collectionId}/items`)
			.pipe(switchMap((rows) => from(this.openItems(rows))));
	}

	getItem(itemId: number): Observable<ItemDetail> {
		return this.http.get<ItemRow>(`${this.baseUrl}/items/${itemId}`).pipe(switchMap((row) => from(this.openItem(row))));
	}

	createItem(
		collectionId: number,
		itemType: ItemType,
		pgn: string,
		title?: string,
		author?: string,
	): Observable<ItemSummary> {
		return from(this.sealItem({ pgn, title: title ?? null, author: author ?? null })).pipe(
			switchMap((payload) => this.http.post<ItemRow>(`${this.baseUrl}/${collectionId}/items`, { itemType, payload })),
			switchMap((row) => from(this.openItem(row))),
			tap(() => this.changes.cloud(collectionId)),
		);
	}

	updateItem(
		itemId: number,
		pgn: string,
		title?: string,
		author?: string,
		itemType?: ItemType,
	): Observable<ItemSummary> {
		return from(this.sealItem({ pgn, title: title ?? null, author: author ?? null })).pipe(
			switchMap((payload) => this.http.put<ItemRow>(`${this.baseUrl}/items/${itemId}`, { payload, itemType })),
			switchMap((row) => from(this.openItem(row))),
			tap((item) => this.changes.cloud(item.collectionId)),
		);
	}

	retagItem(itemId: number, itemType: ItemType): Observable<ItemSummary> {
		return this.http.patch<ItemRow>(`${this.baseUrl}/items/${itemId}/type`, { itemType }).pipe(
			switchMap((row) => from(this.openItem(row))),
			tap((item) => this.changes.cloud(item.collectionId)),
		);
	}

	removeItem(itemId: number, collectionId?: number): Observable<void> {
		return this.http.delete<void>(`${this.baseUrl}/items/${itemId}`).pipe(tap(() => this.changes.cloud(collectionId)));
	}

	reorderItems(collectionId: number, itemIds: readonly number[]): Observable<ItemSummary[]> {
		return this.http.patch<ItemRow[]>(`${this.baseUrl}/${collectionId}/items/order`, { itemIds }).pipe(
			switchMap((rows) => from(this.openItems(rows))),
			tap(() => this.changes.cloud(collectionId)),
		);
	}

	// itemType is supplied by the caller, not derived here, so a mirrored file's own typing is kept.
	addItems(
		collectionId: number,
		entries: readonly { itemType: ItemType; pgn: string }[],
	): Observable<{ imported: number; skippedForSpace: number; items: ItemDetail[] }> {
		return from(
			Promise.all(
				entries.map(async (entry) => ({
					itemType: entry.itemType,
					payload: await this.sealItem({ pgn: entry.pgn, title: null, author: null }),
				})),
			),
		).pipe(
			switchMap((items) =>
				this.http.post<{ imported: number; skippedForSpace: number; items: ItemRow[] }>(
					`${this.baseUrl}/${collectionId}/items/batch`,
					{ items },
				),
			),
			switchMap((result) =>
				from(this.openItems(result.items)).pipe(
					map((items) => ({ imported: result.imported, skippedForSpace: result.skippedForSpace, items })),
				),
			),
		);
	}

	importPgn(collectionId: number, pgn: string, itemType?: ItemType): Observable<ImportResult> {
		return this.get(collectionId).pipe(
			switchMap((collection) => {
				const parsed = splitPgn(pgn);
				const games = parsed.filter((game) => game.plyCount > 0 || Object.keys(game.tags).length > 0);
				const skipped = parsed.length - games.length;

				if (games.length === 0) {
					throw new Error('That file contains no games');
				}

				return from(
					Promise.all(
						games.map(async (game) => ({
							itemType: itemType ?? importTypeFor(collection.kind, game),
							payload: await this.sealItem({ pgn: game.pgn, title: null, author: null }),
						})),
					),
				).pipe(
					switchMap((items) =>
						this.http.post<{
							collectionId: number;
							imported: number;
							skippedForSpace: number;
							items: ItemRow[];
						}>(`${this.baseUrl}/${collectionId}/items/batch`, { items }),
					),
					switchMap((result) =>
						from(this.openItems(result.items)).pipe(
							map((opened) => ({
								collectionId: result.collectionId,
								imported: result.imported,
								skipped,
								skippedForSpace: result.skippedForSpace,
								items: opened,
							})),
						),
					),
					tap(() => this.changes.cloud(collectionId)),
				);
			}),
		);
	}

	transferItems(targetCollectionId: number, itemIds: readonly number[], copy: boolean): Observable<ItemSummary[]> {
		let sources: number[] = [];
		return forkJoin({
			target: this.get(targetCollectionId),
			items: forkJoin(itemIds.map((id) => this.getItem(id))),
		}).pipe(
			tap(({ items }) => (sources = items.map((item) => item.collectionId))),
			switchMap(({ target, items }) =>
				this.http.post<ItemRow[]>(`${this.baseUrl}/${targetCollectionId}/items/transfer`, {
					items: items.map((item) => ({
						itemId: item.id,
						itemType: convertTypeTo(target.kind, item.itemType, item.startFen),
					})),
					copy,
				}),
			),
			switchMap((rows) => from(this.openItems(rows))),
			tap(() => {
				this.changes.cloud(targetCollectionId);
				if (!copy) {
					for (const source of new Set(sources)) {
						this.changes.cloud(source);
					}
				}
			}),
		);
	}

	exportCollection(id: number): Observable<Blob> {
		return this.listDetails(id).pipe(map((items) => new Blob([joinPgn(items)], { type: 'application/x-chess-pgn' })));
	}

	exportArchive(kind: CollectionKind, color: RepertoireColor | null, ids: readonly number[] = []): Observable<Blob> {
		return this.list(kind, color).pipe(
			map((all) => (ids.length === 0 ? all : all.filter((collection) => ids.includes(collection.id)))),
			switchMap((chosen) =>
				chosen.length === 0
					? of(buildZip([]))
					: forkJoin(chosen.map((collection) => this.listDetails(collection.id))).pipe(
							map((contents) => buildZip(zipEntriesFor(chosen, contents))),
						),
			),
		);
	}

	fileNameFor(name: string): string {
		const cleaned = fileNameSafe(name.trim()).trim().slice(0, 80).trim();
		return cleaned.length === 0 ? 'collection' : cleaned;
	}

	repertoireTree(itemId: number): Observable<RepertoireTree> {
		return this.getItem(itemId).pipe(
			switchMap((trunk) =>
				forkJoin({
					trunk: of(trunk),
					collection: this.get(trunk.collectionId),
					items: this.listDetails(trunk.collectionId),
				}),
			),
			switchMap(({ trunk, collection, items }) =>
				from(import('../repertoire/repertoire-linker')).pipe(
					map(({ buildRepertoireTree }) => buildRepertoireTree(trunk, collection, items)),
				),
			),
		);
	}

	storage(): Observable<StorageUsage> {
		return this.http.get<StorageUsage>(`${this.baseUrl}/storage`);
	}

	private sealItem(payload: ItemPayload): Promise<string> {
		return this.vault.seal('item', writePayload(payload));
	}

	private async openItem(row: ItemRow): Promise<ItemDetail> {
		const payload = readPayload(await this.vault.open('item', row.payload));
		const fields = deriveFields(row.itemType, parsePgn(payload.pgn), payload.title, payload.author);

		return {
			id: row.id,
			collectionId: row.collectionId,
			itemType: row.itemType,
			shape: shapeOf(row.itemType),
			sortOrder: row.sortOrder,
			pgn: payload.pgn,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			...fields,
		};
	}

	// Sequential, not Promise.all: firing every decrypt/decompress in a folder together blocks the tab.
	private async openItems(rows: readonly ItemRow[]): Promise<ItemDetail[]> {
		const opened: ItemDetail[] = [];
		for (const row of rows) {
			try {
				opened.push(await this.openItem(row));
			} catch (error) {
				// A locked vault would fail every row; rethrow rather than return a misleadingly empty list.
				if (error instanceof VaultLockedError) {
					throw error;
				}
				console.warn(`Entry ${row.id} could not be decrypted and was left out of the list`, error);
			}
		}
		return opened;
	}

	private async openCollection(row: WireCollectionSummary): Promise<CollectionSummary> {
		return { ...row, name: await this.vault.open('collection-name', row.nameCipher) };
	}

	// Same rule as openItems: a bad row is dropped, a locked vault is rethrown.
	private async openCollections(rows: readonly WireCollectionSummary[]): Promise<CollectionSummary[]> {
		const opened: CollectionSummary[] = [];
		for (const row of rows) {
			try {
				opened.push(await this.openCollection(row));
			} catch (error) {
				if (error instanceof VaultLockedError) {
					throw error;
				}
				console.warn(`Collection ${row.id} could not be decrypted and was left out of the list`, error);
			}
		}
		return opened;
	}

	private async planCollectionTransfer(
		kind: CollectionKind,
		sources: readonly CollectionSummary[],
		contents: readonly ItemDetail[][],
		existing: readonly CollectionSummary[],
		copy: boolean,
	) {
		const taken = new Set(existing.map((collection) => collection.name.toLowerCase()));
		const planned = [];

		for (let i = 0; i < sources.length; i++) {
			const source = sources[i];
			const items = contents[i] ?? [];

			const name = copy || taken.has(source.name.toLowerCase()) ? freeName(taken, source.name) : null;
			if (name !== null) {
				taken.add(name.toLowerCase());
			}

			const retyped = items.map((item) => ({
				itemId: item.id,
				itemType: convertTypeTo(kind, item.itemType, item.startFen),
			}));

			const needsTrunk = kind === 'REPERTOIRE' && !retyped.some((item) => item.itemType === 'MAIN_LINE');

			planned.push({
				collectionId: source.id,
				nameCipher: name === null ? null : await this.vault.seal('collection-name', name),
				items: retyped,
				trunkPayload: needsTrunk ? await this.sealedEmptyTrunk() : null,
			});
		}
		return planned;
	}
}

// Same set the server's fileName() stripped: characters Windows forbids in a path component.
const FORBIDDEN_IN_FILE_NAME: ReadonlySet<string> = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

function fileNameSafe(name: string): string {
	let safe = '';
	for (const character of name) {
		const code = character.codePointAt(0) ?? 0;
		safe += FORBIDDEN_IN_FILE_NAME.has(character) || code < 0x20 ? '-' : character;
	}
	return safe;
}

function sortItems(items: readonly ItemDetail[], sort: ItemSortKey, ascending?: boolean): ItemSummary[] {
	return compareItems(items, sort, ascending);
}

function joinPgn(items: readonly ItemDetail[]): string {
	const bodies = items.map((item) => item.pgn.trim()).filter((pgn) => pgn.length > 0);
	return `${bodies.join('\n\n')}\n`;
}

function zipEntriesFor(collections: readonly CollectionSummary[], contents: readonly ItemDetail[][]) {
	const used = new Set<string>();
	return collections.map((collection, index) => {
		const base = fileNameSafe(collection.name.trim()).slice(0, 80) || 'collection';
		let name = `${base}.pgn`;
		for (let suffix = 2; used.has(name); suffix++) {
			name = `${base} (${suffix}).pgn`;
		}
		used.add(name);
		return { name, text: joinPgn(contents[index] ?? []) };
	});
}

function freeName(taken: ReadonlySet<string>, name: string): string {
	if (!taken.has(name.toLowerCase())) {
		return name;
	}
	for (let suffix = 2; suffix < 1000; suffix++) {
		const candidate = `${name} (${suffix})`;
		if (!taken.has(candidate.toLowerCase())) {
			return candidate;
		}
	}
	throw new Error(`Too many collections called "${name}"`);
}
