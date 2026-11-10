import { Chess } from 'chess.js';
import { AdvancedReport, ArchiveGame, ReportGame, ReportMove, ReportNode, ReportPoint } from '../models/report.model';
import { Book, BookNode, bookPathOf } from './repertoire-book';
import { cleanSan } from '../chess/pgn-tree';

const MAX_PLY = 60;

// The most recent game per move; the rest are a click away in the Player's Opening Tree.
const SAMPLE_GAMES = 1;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

	// Every game of one player shares its first moves with many others, so a move is worked out once
	// per position and only as far as the book reaches: replaying whole games is what made this slow.
	private readonly positions = new Positions();

	game(game: ArchiveGame): void {
		this.gamesRead++;
		if (game.movesSan === null || game.movesSan.trim().length === 0) {
			return;
		}

		const san = sanMoves(game.movesSan);
		let position = this.positions.root;
		const first = position.after(san[0]);
		if (first === null) {
			return;
		}

		let node = this.book.root;
		this.visits.set(node, (this.visits.get(node) ?? 0) + 1);

		for (let ply = 0; ply < san.length && ply < MAX_PLY; ply++) {
			// A move that does not replay ends the game there; the moves before it still count.
			const step = ply === 0 ? first : position.after(san[ply]);
			if (step === null) {
				return;
			}
			position = step.position;

			const child = node.children.get(step.uci);

			if (child !== undefined) {
				node = child;
				this.visits.set(node, (this.visits.get(node) ?? 0) + 1);
				continue;
			}

			if (node.children.size > 0) {
				// The SAN is the archive's own token, not something re-derived.
				const label = san[ply];

				let atNode = this.leaving.get(node);
				if (atNode === undefined) {
					atNode = new Map();
					this.leaving.set(node, atNode);
				}

				let departure = atNode.get(step.uci);
				if (departure === undefined) {
					departure = new Departure(step.uci, label);
					atNode.set(step.uci, departure);
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
			after: numbered(node),
			moves,
			book: node.sources.map((source) => ({ ...source })),
		};
	}
}

function numbered(node: BookNode): string | null {
	if (node.san === null || node.ply === 0) {
		return null;
	}
	const number = Math.ceil(node.ply / 2);
	return node.ply % 2 === 1 ? `${number}.${node.san}` : `${number}…${node.san}`;
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

interface Step {
	readonly uci: string;
	readonly position: Position;
}

// One position reached by some game, and the moves already worked out from it, by their SAN.
class Position {
	private readonly next = new Map<string, Step | null>();

	constructor(
		private readonly positions: Positions,
		readonly fen: string,
	) {
		// Parameter properties only.
	}

	after(san: string | undefined): Step | null {
		if (san === undefined) {
			return null;
		}
		let step = this.next.get(san);
		if (step === undefined) {
			step = this.positions.play(this.fen, san);
			this.next.set(san, step);
		}
		return step;
	}
}

class Positions {
	readonly root = new Position(this, START_FEN);

	private readonly board = new Chess();

	play(fen: string, san: string): Step | null {
		try {
			this.board.load(fen);
			const move = this.board.move(san);
			return { uci: `${move.from}${move.to}${move.promotion ?? ''}`, position: new Position(this, this.board.fen()) };
		} catch {
			return null;
		}
	}
}
