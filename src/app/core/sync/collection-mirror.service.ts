import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AgentBridgeService } from '../agent/agent-bridge.service';
import { LocalFolderEntryDetail } from '../agent/agent.models';
import { LocalShelfService } from '../agent/local-shelf.service';
import { VaultService } from '../crypto/vault.service';
import { ApiError } from '../interceptors/error.interceptor';
import { CollectionKind, ItemDetail, ItemType, RepertoireColor } from '../models/collection.model';
import { AuthService } from '../services/auth.service';
import { CollectionApiService } from '../services/collection-api.service';
import { NotificationService } from '../services/notification.service';
import { CollectionChangesService } from './collection-changes.service';

// Names a game across both copies; the shell reads and writes this same tag.
export const UID_TAG = 'PremovedUid';
// A file keeps its entry's type in this tag; the cloud keeps it as a column instead.
export const TYPE_TAG = 'PremovedType';

const SETTLE_MS = 1500;

export interface MirrorPair {
	readonly id: string;
	readonly kind: CollectionKind;
	readonly color: RepertoireColor | null;
	readonly name: string;
	readonly updatedAt: string;
	readonly cloudId: number | null;
	readonly syncedDigest?: string | null;
}

type Direction = 'push' | 'pull';

interface Entry {
	readonly uid: string | null;
	readonly type: ItemType;
	readonly pgn: string;
}

// Pair sync: the side still matching syncedDigest is overwritten by the other; if both changed,
// the newer wins and the other is kept as a separate local file.
@Injectable({ providedIn: 'root' })
export class CollectionMirrorService {
	private readonly api = inject(CollectionApiService);
	private readonly shelf = inject(LocalShelfService);
	private readonly bridge = inject(AgentBridgeService);
	private readonly auth = inject(AuthService);
	private readonly vault = inject(VaultService);
	private readonly notify = inject(NotificationService);
	private readonly changes = inject(CollectionChangesService);

	readonly revision = signal(0);

	private readonly running = new Map<string, boolean>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor() {
		this.changes.changes.subscribe((change) => {
			const key = change.side === 'local' ? `local:${change.localId}` : `cloud:${change.cloudId}`;
			const pending = this.timers.get(key);
			if (pending) {
				clearTimeout(pending);
			}
			this.timers.set(
				key,
				setTimeout(() => {
					this.timers.delete(key);
					void this.follow(change.side === 'local' ? { localId: change.localId } : { cloudId: change.cloudId });
				}, SETTLE_MS),
			);
		});

		effect(() => {
			const ready = this.auth.isLoggedIn() && this.bridge.connected() && this.vault.unlocked();
			if (ready) {
				untracked(() => void this.syncAll());
			}
		});

		if (typeof window !== 'undefined') {
			window.addEventListener('online', () => void this.syncAll());
		}
	}

	async syncAll(): Promise<void> {
		if (!this.ready()) {
			return;
		}
		for (const pair of await this.pairs()) {
			await this.sync(pair);
		}
	}

	async sync(pair: MirrorPair, force?: Direction): Promise<boolean> {
		if (pair.cloudId === null || !this.ready()) {
			return false;
		}
		if (this.running.has(pair.id)) {
			this.running.set(pair.id, true);
			return false;
		}
		this.running.set(pair.id, false);
		try {
			const changed = await this.syncOnce(pair, force);
			if (changed) {
				this.revision.update((value) => value + 1);
			}
			return changed;
		} catch (error) {
			this.report(pair, error);
			return false;
		} finally {
			const again = this.running.get(pair.id) === true;
			this.running.delete(pair.id);
			if (again) {
				const fresh = (await this.pairs()).find((candidate) => candidate.id === pair.id);
				if (fresh) {
					void this.sync(fresh);
				}
			}
		}
	}

	private ready(): boolean {
		return this.auth.isLoggedIn() && this.bridge.connected() && this.vault.unlocked();
	}

	private async pairs(): Promise<MirrorPair[]> {
		const shelves: [CollectionKind, RepertoireColor | null][] = [
			['LIBRARY', null],
			['REPERTOIRE', 'w'],
			['REPERTOIRE', 'b'],
		];
		const found: MirrorPair[] = [];
		for (const [kind, color] of shelves) {
			for (const file of await this.shelf.shelf(kind, color)) {
				if (file.cloudId !== null) {
					found.push(file);
				}
			}
		}
		return found;
	}

	private async follow(change: { localId: string } | { cloudId: number }): Promise<void> {
		if (!this.ready()) {
			return;
		}
		const pair = (await this.pairs()).find((candidate) =>
			'localId' in change ? candidate.id === change.localId : candidate.cloudId === change.cloudId,
		);
		if (pair) {
			await this.sync(pair);
		}
	}

	private async syncOnce(pair: MirrorPair, force?: Direction): Promise<boolean> {
		const cloudId = pair.cloudId as number;

		let items: ItemDetail[];
		try {
			items = await firstValueFrom(this.api.listDetails(cloudId));
		} catch (error) {
			if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
				return false;
			}
			throw error;
		}
		const local = await this.shelf.detailsOrFail(pair.id);

		const localEntries = local.map(fromFile);
		const cloudEntries = items.map(fromCloud);
		const localDigest = await digest(localEntries);
		const cloudDigest = await digest(cloudEntries);
		const baseline = pair.syncedDigest ?? null;

		if (localDigest === cloudDigest && !force) {
			if (baseline !== localDigest) {
				await this.shelf.markSynced(pair.id, localDigest);
			}
			return false;
		}

		let direction: Direction;
		let conflict = false;
		if (force) {
			direction = force;
		} else if (baseline === localDigest) {
			direction = 'pull';
		} else if (baseline === cloudDigest) {
			direction = 'push';
		} else if (baseline === null && (localEntries.length === 0) !== (cloudEntries.length === 0)) {
			// Never agreed, and one side is empty: an empty copy is never the one worth keeping.
			direction = localEntries.length > 0 ? 'push' : 'pull';
		} else {
			// Both changed since they last agreed, or no baseline was ever recorded: the newer side wins.
			conflict = true;
			direction = newest(pair.updatedAt, items) === 'local' ? 'push' : 'pull';
		}

		if (conflict) {
			await this.keepLoser(pair, direction, local, items);
		}

		const agreed = direction === 'push' ? await this.push(pair, cloudId, local, items) : await this.pull(pair, items);
		await this.shelf.markSynced(pair.id, agreed);
		return true;
	}

	private async push(
		pair: MirrorPair,
		cloudId: number,
		local: readonly LocalFolderEntryDetail[],
		items: readonly ItemDetail[],
	): Promise<string> {
		let entries = local.map(fromFile);
		if (entries.some((entry) => entry.uid === null)) {
			entries = entries.map((entry) => {
				if (entry.uid !== null) {
					return entry;
				}
				const uid = newUid();
				return { ...entry, uid, pgn: setTags(entry.pgn, { [UID_TAG]: uid }) };
			});
			await this.shelf.write(pair.id, fileText(entries));
		}

		const claimed = new Set<number>();
		const byUid = new Map<string, ItemDetail>();
		for (const item of items) {
			const uid = tagOf(item.pgn, UID_TAG);
			if (uid !== null && !byUid.has(uid)) {
				byUid.set(uid, item);
			}
		}
		const match = new Map<string, ItemDetail>();
		for (const entry of entries) {
			const item = byUid.get(entry.uid as string);
			if (item && !claimed.has(item.id)) {
				match.set(entry.uid as string, item);
				claimed.add(item.id);
			}
		}
		// Entries without a uid match by identical content instead, for a cloud copy predating uids.
		for (const entry of entries) {
			if (match.has(entry.uid as string)) {
				continue;
			}
			const same = items.find(
				(item) => !claimed.has(item.id) && tagOf(item.pgn, UID_TAG) === null && normal(item.pgn) === normal(entry.pgn),
			);
			if (same) {
				match.set(entry.uid as string, same);
				claimed.add(same.id);
			}
		}

		for (const item of items) {
			if (!claimed.has(item.id)) {
				await firstValueFrom(this.api.removeItem(item.id));
			}
		}

		const ids = new Map<string, number>();
		for (const entry of entries) {
			const item = match.get(entry.uid as string);
			if (!item) {
				continue;
			}
			ids.set(entry.uid as string, item.id);
			const stored = cloudPgn(entry.pgn);
			if (item.itemType !== entry.type || item.pgn.trim() !== stored.trim()) {
				await firstValueFrom(this.api.updateItem(item.id, stored, undefined, undefined, entry.type));
			}
		}

		const added = entries.filter((entry) => !match.has(entry.uid as string));
		if (added.length > 0) {
			const result = await firstValueFrom(
				this.api.addItems(
					cloudId,
					added.map((entry) => ({ itemType: entry.type, pgn: cloudPgn(entry.pgn) })),
				),
			);
			if (result.skippedForSpace > 0) {
				this.notify.error(
					`"${pair.name}": ${result.skippedForSpace} game(s) did not fit in your cloud storage and stay only on this computer.`,
				);
			}
			for (const item of result.items) {
				const uid = tagOf(item.pgn, UID_TAG);
				if (uid !== null) {
					ids.set(uid, item.id);
				}
			}
		}

		const order = entries.map((entry) => ids.get(entry.uid as string)).filter((id): id is number => id !== undefined);
		const current = (await firstValueFrom(this.api.listDetails(cloudId))).map((item) => item.id);
		if (order.length === current.length && order.some((id, at) => current[at] !== id)) {
			await firstValueFrom(this.api.reorderItems(cloudId, order));
		}

		return digest(entries);
	}

	private async pull(pair: MirrorPair, items: readonly ItemDetail[]): Promise<string> {
		const entries: Entry[] = [];
		for (const item of items) {
			let pgn = item.pgn;
			if (tagOf(pgn, UID_TAG) === null) {
				pgn = setTags(pgn, { [UID_TAG]: newUid() });
				await firstValueFrom(
					this.api.updateItem(item.id, pgn, item.title ?? undefined, item.author ?? undefined, item.itemType),
				);
			}
			entries.push({ uid: tagOf(pgn, UID_TAG), type: item.itemType, pgn });
		}
		await this.shelf.write(pair.id, fileText(entries));
		return digest(entries);
	}

	// The losing side is kept as a separate local file rather than discarded.
	private async keepLoser(
		pair: MirrorPair,
		winner: Direction,
		local: readonly LocalFolderEntryDetail[],
		items: readonly ItemDetail[],
	): Promise<void> {
		const losing =
			winner === 'push'
				? items.map((item) => ({ uid: tagOf(item.pgn, UID_TAG), type: item.itemType, pgn: item.pgn }))
				: local.map(fromFile);
		const label = winner === 'push' ? 'cloud version' : 'this computer\u2019s version';
		const written = await this.shelf.adopt({
			kind: pair.kind,
			color: pair.color,
			name: `${pair.name} (${label})`,
			pgn: fileText(losing),
			cloudId: null,
		});
		this.notify.info(
			`"${pair.name}" differed between this computer and the cloud. The newer version was kept in both; the other is saved on this computer as "${written.name}".`,
		);
	}

	private report(pair: MirrorPair, error: unknown): void {
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			return;
		}
		if (error instanceof ApiError && error.status === 0) {
			return;
		}
		console.warn(`Could not sync "${pair.name}" with its cloud copy`, error);
		if (error instanceof ApiError && error.status === 507) {
			this.notify.error(`"${pair.name}" could not be updated in the cloud: your cloud storage is full.`);
		}
	}
}

function fromFile(entry: LocalFolderEntryDetail): Entry {
	return { uid: tagOf(entry.pgn, UID_TAG), type: entry.itemType as ItemType, pgn: entry.pgn };
}

function fromCloud(item: ItemDetail): Entry {
	return { uid: tagOf(item.pgn, UID_TAG), type: item.itemType, pgn: item.pgn };
}

// SHA-256 of every entry's identifier, type and normalized content, in order.
async function digest(entries: readonly Entry[]): Promise<string> {
	const text = JSON.stringify(entries.map((entry) => [entry.uid, entry.type, normal(entry.pgn)]));
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const TAG_LINE = /^\s*\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/;

// Tags sorted, whitespace collapsed, UID/TYPE tags excluded: bookkeeping differences aren't edits.
function normal(pgn: string): string {
	const tags: string[] = [];
	const moves: string[] = [];
	for (const line of pgn.replace(/\r\n?/g, '\n').split('\n')) {
		const tag = TAG_LINE.exec(line);
		if (tag) {
			if (tag[1] !== UID_TAG && tag[1] !== TYPE_TAG) {
				tags.push(`${tag[1]}=${tag[2].replace(/\\(["\\])/g, '$1')}`);
			}
		} else {
			moves.push(line);
		}
	}
	return `${tags.sort().join('\n')}\n${moves.join(' ').replace(/\s+/g, ' ').trim()}`;
}

function tagOf(pgn: string, name: string): string | null {
	for (const line of pgn.split(/\r?\n/)) {
		const tag = TAG_LINE.exec(line);
		if (tag && tag[1] === name) {
			const value = tag[2].trim();
			return value.length > 0 ? value : null;
		}
	}
	return null;
}

function setTags(pgn: string, values: Readonly<Record<string, string | null>>): string {
	const lines = pgn.replace(/\r\n?/g, '\n').trim().split('\n');
	const kept = lines.filter((line) => {
		const tag = TAG_LINE.exec(line);
		return !(tag && tag[1] in values);
	});
	const added = Object.entries(values)
		.filter((pair): pair is [string, string] => pair[1] !== null)
		.map(([name, value]) => `[${name} "${value.replace(/([\\"])/g, '\\$1')}"]`);

	let at = 0;
	while (at < kept.length && TAG_LINE.test(kept[at])) {
		at++;
	}
	if (at === 0 && added.length > 0) {
		return [...added, '', ...kept].join('\n');
	}
	return [...kept.slice(0, at), ...added, ...kept.slice(at)].join('\n');
}

function cloudPgn(pgn: string): string {
	return `${setTags(pgn, { [TYPE_TAG]: null })}\n`;
}

function fileText(entries: readonly Entry[]): string {
	const games = entries.map((entry) => {
		const values: Record<string, string | null> = { [TYPE_TAG]: entry.type };
		if (entry.uid !== null) {
			values[UID_TAG] = entry.uid;
		}
		return `${setTags(entry.pgn, values).trim()}\n`;
	});
	return games.join('\n');
}

function newUid(): string {
	return crypto.randomUUID();
}

// Which copy was touched last: the file's time against the latest edit to any cloud entry.
function newest(fileUpdatedAt: string, items: readonly ItemDetail[]): 'local' | 'cloud' {
	const file = Date.parse(fileUpdatedAt) || 0;
	const cloud = items.reduce((latest, item) => Math.max(latest, Date.parse(item.updatedAt) || 0), 0);
	return file >= cloud ? 'local' : 'cloud';
}
