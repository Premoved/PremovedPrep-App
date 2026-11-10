import { ItemDetail } from '../models/collection.model';
import { ReportBookFile } from '../models/report.model';
import { PgnTreeNode, STANDARD_EPD, parsePgnTree } from '../chess/pgn-tree';

export type BookSource = ReportBookFile;

/** What the card shows about the collection a main line is filed in. */
export interface BookCollection {
	readonly name: string;
	readonly icon: string;
}

export interface BookNode {
	readonly parent: BookNode | null;
	readonly uci: string | null;
	readonly san: string | null;
	readonly fen: string;
	readonly ply: number;
	/** Keyed by UCI, in insertion order - the order the files contributed them. */
	readonly children: Map<string, BookNode>;
	readonly sources: BookSource[];
}

export interface Book {
	readonly root: BookNode;
	readonly files: number;
}

const MAX_PLY = 60;

const DEFAULT_TITLE = 'Main line';

// A trunk not starting from the standard position is skipped: unreachable from move one.
export function buildBook(
	trunks: readonly ItemDetail[],
	collections: ReadonlyMap<number, BookCollection> = new Map(),
	localEntries: ReadonlyMap<number, string> = new Map(),
): Book {
	const root: BookNode = {
		parent: null,
		uci: null,
		san: null,
		fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
		ply: 0,
		children: new Map(),
		sources: [],
	};

	let files = 0;

	for (const trunk of trunks) {
		const parsed = parsePgnTree(trunk.pgn, trunk.startFen);
		if (parsed.epd !== STANDARD_EPD) {
			continue;
		}

		files++;
		merge(root, parsed, sourceOf(trunk, collections.get(trunk.collectionId), localEntries.get(trunk.id) ?? null));
	}

	return { root, files };
}

export function isEmptyBook(book: Book): boolean {
	return book.root.children.size === 0;
}

export function bookPathOf(node: BookNode): string[] {
	const path: string[] = [];
	for (let current: BookNode | null = node; current?.uci != null; current = current.parent) {
		path.unshift(current.uci);
	}
	return path;
}

function merge(into: BookNode, from: PgnTreeNode, source: BookSource): void {
	if (!into.sources.some((existing) => existing.itemId === source.itemId)) {
		into.sources.push(source);
	}
	if (into.ply >= MAX_PLY) {
		return;
	}

	for (const child of from.children) {
		if (child.uci === null) {
			continue;
		}

		let merged = into.children.get(child.uci);
		if (merged === undefined) {
			merged = {
				parent: into,
				uci: child.uci,
				san: child.san,
				fen: child.fen,
				ply: into.ply + 1,
				children: new Map(),
				sources: [],
			};
			into.children.set(child.uci, merged);
		}
		merge(merged, child, source);
	}
}

function sourceOf(trunk: ItemDetail, collection: BookCollection | undefined, localEntryId: string | null): BookSource {
	return {
		itemId: trunk.id,
		localEntryId,
		title: titleOf(trunk),
		collectionName: collection?.name ?? null,
		collectionIcon: collection?.icon ?? null,
		white: trunk.white,
		black: trunk.black,
		year: trunk.year,
		annotator: trunk.annotator,
	};
}

function titleOf(trunk: ItemDetail): string {
	const name = trunk.event?.trim();
	return name === undefined || name.length === 0 ? DEFAULT_TITLE : name;
}
