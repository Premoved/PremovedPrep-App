import { Chess } from 'chess.js';
import { AdvancedReport, ArchiveGame, ReportGame, ReportMove, ReportNode, ReportPoint } from '../models/report.model';
import { Book, BookNode, bookPathOf } from './repertoire-book';
import { cleanSan } from '../chess/pgn-tree';

const MAX_PLY = 60;

const SAMPLE_GAMES = 5;

// Prefix lengths retried when a game's movetext will not fully replay.
const RETRY_PREFIXES = [40, 24, 16, 10, 6, 4, 2];

// Runs in the browser: the repertoire is end-to-end encrypted and the server cannot read it
// to build this overlay, only the opponent's public games.
export function buildAdvancedReport(
	book: Book,
	games: readonly ArchiveGame[],
	fideId: number,
	opponentColor: 'w' | 'b',
	truncated: boolean,
): AdvancedReport {
	const ourColor = opponentColor === 'b' ? 'w' : 'b';
	const walk = new Walk(book, ourColor);

	for (const game of games) {
		walk.game(game);
	}

	const emit = new Emit(walk);
	const root = emit.node(book.root);

	return {
		fideId,
		opponentColor,
		repertoireColor: ourColor,
		repertoireFiles: book.files,
		gamesRead: walk.gamesRead,
		truncated,
		overlaps: emit.overlaps,
		deviations: emit.deviations,
		root,
	};
}

class Departure {
	games = 0;
	private readonly sample: ReportGame[] = [];

	constructor(
		readonly uci: string,
		readonly san: string,
	) {
		// Parameter properties only.
	}

	add(game: ArchiveGame, ply: number): void {
		this.games++;
		this.sample.push({
			id: game.id,
			white: game.white,
			whiteElo: game.whiteElo,
			black: game.black,
			blackElo: game.blackElo,
			result: game.result,
			year: game.year,
			event: game.event,
			ply,
		});
	}

	toMove(): ReportMove {
		const sorted = [...this.sample].sort((a, b) => {
			const byYear = (b.year ?? 0) - (a.year ?? 0);
			return byYear !== 0 ? byYear : b.id - a.id;
		});

		return { uci: this.uci, san: this.san, games: this.games, sample: sorted.slice(0, SAMPLE_GAMES) };
	}
}

class Walk {
	gamesRead = 0;

	readonly visits = new Map<BookNode, number>();
	readonly leaving = new Map<BookNode, Map<string, Departure>>();

	private readonly weAreWhite: boolean;

	constructor(
		private readonly book: Book,
		ourColor: 'w' | 'b',
	) {
		this.weAreWhite = ourColor === 'w';
	}

	game(game: ArchiveGame): void {
		this.gamesRead++;
		if (game.movesSan === null || game.movesSan.trim().length === 0) {
			return;
		}

		const san = sanMoves(game.movesSan);
		const moves = replay(san);
		if (moves === null) {
			return;
		}

		let node = this.book.root;
		this.visits.set(node, (this.visits.get(node) ?? 0) + 1);

		for (let ply = 0; ply < moves.length && ply < MAX_PLY; ply++) {
			const child = node.children.get(moves[ply]);

			if (child !== undefined) {
				node = child;
				this.visits.set(node, (this.visits.get(node) ?? 0) + 1);
				continue;
			}

			if (node.children.size > 0) {
				// The SAN is the archive's own token, not something re-derived.
				const label = ply < san.length ? san[ply] : moves[ply];

				let atNode = this.leaving.get(node);
				if (atNode === undefined) {
					atNode = new Map();
					this.leaving.set(node, atNode);
				}

				let departure = atNode.get(moves[ply]);
				if (departure === undefined) {
					departure = new Departure(moves[ply], label);
					atNode.set(moves[ply], departure);
				}
				departure.add(game, node.ply);
			}
			return;
		}
	}

	oursToMove(node: BookNode): boolean {
		return this.weAreWhite === (node.ply % 2 === 0);
	}
}

class Emit {
	overlaps = 0;
	deviations = 0;

	constructor(private readonly walk: Walk) {
		// Parameter properties only.
	}

	node(node: BookNode): ReportNode {
		const games = this.walk.visits.get(node) ?? 0;
		const point = this.point(node);

		const children: ReportNode[] = [];
		for (const child of node.children.values()) {
			if ((this.walk.visits.get(child) ?? 0) > 0) {
				children.push(this.node(child));
			}
		}

		return { uci: node.uci, san: node.san, games, point, children };
	}

	private point(node: BookNode): ReportPoint | null {
		const left = this.walk.leaving.get(node);
		if (left === undefined || left.size === 0) {
			return null;
		}

		// Leaving the book on our move = OVERLAP; on theirs = DEVIATION.
		const ours = this.walk.oursToMove(node);
		const kind = ours ? 'OVERLAP' : 'DEVIATION';
		const index = ours ? ++this.overlaps : ++this.deviations;

		const moves = [...left.values()].map((departure) => departure.toMove()).sort((a, b) => b.games - a.games);

		return {
			kind,
			index,
			line: bookPathOf(node),
			moves,
			book: node.sources.map((source) => ({ itemId: source.itemId, title: source.title })),
		};
	}
}

// movesSan is already normalised (no comments/variations), so this only splits and cleans tokens.
function sanMoves(movetext: string): string[] {
	const moves: string[] = [];
	for (const token of movetext.trim().split(/\s+/)) {
		const move = cleanSan(token);
		if (move.length > 0) {
			moves.push(move);
		}
	}
	return moves;
}

// Shrinks the prefix and retries rather than discarding a game that fails to fully replay.
function replay(san: readonly string[]): string[] | null {
	for (const limit of limits(san.length)) {
		const board = new Chess();
		const moves: string[] = [];

		for (let i = 0; i < limit; i++) {
			try {
				const move = board.move(san[i]);
				moves.push(`${move.from}${move.to}${move.promotion ?? ''}`);
			} catch {
				moves.length = 0;
				break;
			}
		}

		if (moves.length > 0) {
			return moves;
		}
	}
	return null;
}

function limits(plies: number): number[] {
	const capped = Math.min(plies, MAX_PLY);
	return [capped, ...RETRY_PREFIXES.filter((prefix) => prefix < capped)];
}
