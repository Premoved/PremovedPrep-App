import { CollectionSummary, ItemDetail } from '../models/collection.model';
import { PgnTreeNode, childByUci, mainlineOf, parsePgnTree, pathOf } from '../chess/pgn-tree';
import { RepertoireAttachment, RepertoireBranch, RepertoireGame, RepertoireTree } from '../models/repertoire.model';

// A model game attaches at the deepest trunk position it shares before playing a move the
// trunk does not have; positions are keyed by EPD since nothing is precomputed server-side.
interface TrunkIndex {
	readonly root: PgnTreeNode;
	readonly byPosition: Map<string, PgnTreeNode[]>;
	/** Depth-first, first child first - the order the client draws them in. */
	readonly order: Map<PgnTreeNode, number>;
}

interface Fit {
	readonly node: PgnTreeNode;
	readonly ply: number;
	readonly order: number;
}

interface Walk {
	readonly item: ItemDetail;
	readonly positions: readonly string[];
	readonly moves: readonly string[];
}

export function buildRepertoireTree(
	trunk: ItemDetail,
	collection: CollectionSummary,
	items: readonly ItemDetail[],
): RepertoireTree {
	const trunks = items.filter((item) => item.itemType === 'MAIN_LINE');
	const models = items.filter((item) => item.itemType === 'MODEL_GAME');

	const indexes = new Map<number, TrunkIndex>();
	for (const candidate of trunks) {
		indexes.set(candidate.id, indexTrunk(parsePgnTree(candidate.pgn, candidate.startFen)));
	}
	if (!indexes.has(trunk.id)) {
		indexes.set(trunk.id, indexTrunk(parsePgnTree(trunk.pgn, trunk.startFen)));
	}

	const placements: { walk: Walk; node: PgnTreeNode; ply: number }[] = [];
	for (const model of models) {
		const walk = walkOf(model);
		const placement = placeOn(walk, trunk.id, indexes);
		if (placement !== null) {
			placements.push({ walk, node: placement.node, ply: placement.ply });
		}
	}

	return {
		itemId: trunk.id,
		collectionId: trunk.collectionId,
		color: collection.color,
		modelGames: models.length,
		linked: placements.length,
		attachments: attachmentsFor(placements),
	};
}

// The deepest fit on this trunk, provided no other trunk fits deeper (a tie is drawn on both).
function placeOn(walk: Walk, trunkId: number, indexes: ReadonlyMap<number, TrunkIndex>): Fit | null {
	let best: Fit | null = null;
	let here: Fit | null = null;

	for (const [id, index] of indexes) {
		const fit = fitOn(walk, index);
		if (fit === null) {
			continue;
		}
		if (best === null || fit.ply > best.ply) {
			best = fit;
		}
		if (id === trunkId) {
			here = fit;
		}
	}

	// A tie is drawn on every trunk that ties, not just the deepest one.
	if (best === null || here === null || here.ply < best.ply) {
		return null;
	}
	return here;
}

function fitOn(walk: Walk, trunk: TrunkIndex): Fit | null {
	let best: Fit | null = null;

	for (let ply = 0; ply < walk.positions.length; ply++) {
		const nodes = trunk.byPosition.get(walk.positions[ply]);
		if (nodes === undefined) {
			continue;
		}
		for (const node of nodes) {
			// Past the last move there is nothing left to follow.
			const leaves = ply === walk.moves.length || childByUci(node, walk.moves[ply]) === undefined;
			if (!leaves) {
				continue;
			}

			const order = trunk.order.get(node) ?? Number.MAX_SAFE_INTEGER;
			if (best === null || ply > best.ply || (ply === best.ply && order < best.order)) {
				best = { node, ply, order };
			}
		}
	}
	return best;
}

function attachmentsFor(placements: readonly { walk: Walk; node: PgnTreeNode; ply: number }[]): RepertoireAttachment[] {
	const byNode = new Map<PgnTreeNode, { walk: Walk; ply: number }[]>();
	for (const placement of placements) {
		const group = byNode.get(placement.node) ?? [];
		group.push({ walk: placement.walk, ply: placement.ply });
		byNode.set(placement.node, group);
	}

	const attachments: RepertoireAttachment[] = [];
	for (const [node, group] of byNode) {
		const { branches, ending } = expand(group);
		if (branches.length === 0 && ending.length === 0) {
			continue;
		}
		attachments.push({ path: pathOf(node), games: ending, branches });
	}

	// Shallowest first, so a client drawing them in order never forward-references.
	return attachments.sort((left, right) => left.path.length - right.path.length);
}

function expand(walkers: readonly { walk: Walk; ply: number }[]): {
	branches: RepertoireBranch[];
	ending: RepertoireGame[];
} {
	const ending: RepertoireGame[] = [];
	const byMove = new Map<string, { walk: Walk; ply: number }[]>();

	for (const walker of walkers) {
		if (walker.ply >= walker.walk.moves.length) {
			ending.push(cardFor(walker.walk, walker.ply));
			continue;
		}
		const move = walker.walk.moves[walker.ply];
		const group = byMove.get(move) ?? [];
		group.push(walker);
		byMove.set(move, group);
	}

	const branches: RepertoireBranch[] = [];
	for (const [uci, group] of byMove) {
		if (group.length === 1) {
			const only = group[0];
			// The branch node is the position after this move.
			branches.push({ uci, games: [cardFor(only.walk, only.ply + 1)], children: [] });
			continue;
		}

		const below = expand(group.map((walker) => ({ walk: walker.walk, ply: walker.ply + 1 })));
		branches.push({ uci, games: below.ending, children: below.branches });
	}

	return { branches, ending };
}

function cardFor(walk: Walk, ply: number): RepertoireGame {
	const item = walk.item;
	return {
		itemId: item.id,
		white: item.white,
		whiteElo: item.whiteElo,
		black: item.black,
		blackElo: item.blackElo,
		result: item.result,
		event: item.event,
		date: item.date,
		year: item.year,
		eco: item.eco,
		plyCount: item.plyCount,
		ply: Math.max(0, Math.min(ply, item.plyCount)),
	};
}

// Only the mainline: an annotator's side lines are commentary, not games to attach separately.
function walkOf(item: ItemDetail): Walk {
	const root = parsePgnTree(item.pgn, item.startFen);
	const line = mainlineOf(root);

	return {
		item,
		positions: [root.epd, ...line.map((node) => node.epd)],
		moves: line.map((node) => node.uci as string),
	};
}

function indexTrunk(root: PgnTreeNode): TrunkIndex {
	const byPosition = new Map<string, PgnTreeNode[]>();
	const order = new Map<PgnTreeNode, number>();

	const visit = (node: PgnTreeNode): void => {
		const group = byPosition.get(node.epd) ?? [];
		group.push(node);
		byPosition.set(node.epd, group);
		order.set(node, order.size);

		for (const child of node.children) {
			visit(child);
		}
	};
	visit(root);

	return { root, byPosition, order };
}
