import {
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	HostListener,
	OnDestroy,
	computed,
	effect,
	inject,
	signal,
} from '@angular/core';
import { PgnParserService } from '../../../../core/chess/pgn-parser.service';
import { GameDetail, GameSortKey, GameSummary } from '../../../../core/models/game-list.model';
import { MoveNode, PlyNode } from '../../../../core/models/move-node.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { OpeningExplorerService } from '../../../../core/services/opening-explorer.service';
import { GameListStore } from '../../state/game-list.store';
import { TabsStore } from '../../../../core/tabs/tabs.store';
import { GamePreviewStore } from '../../state/game-preview.store';
import { MoveTreeStore } from '../../state/move-tree.store';
import { GameContextMenuComponent } from './game-context-menu/game-context-menu.component';
import { scrollIntoContainer, scrollableAncestor } from '../../../../core/browser/scroll';

interface ColumnDefinition {
	readonly key: GameSortKey;
	readonly label: string;
	readonly align: 'left' | 'right' | 'center';
}

interface RenderedGame {
	readonly id: number;
	readonly white: string;
	readonly whiteElo: string;
	readonly result: string;
	readonly black: string;
	readonly blackElo: string;
	readonly date: string;
	readonly event: string;
	readonly comment: string;
	readonly label: string;
}

interface OpenMenu {
	readonly game: RenderedGame;
	readonly anchor: DOMRect;
}

// Extra margin so a row scrolled into view doesn't land half under the horizontal scrollbar.
const ROW_CLEARANCE_PX = 24;

@Component({
	selector: 'app-game-list',
	standalone: true,
	imports: [GameContextMenuComponent],
	templateUrl: './game-list.component.html',
	styleUrl: './game-list.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameListComponent implements OnDestroy {
	readonly store = inject(GameListStore);
	private readonly preview = inject(GamePreviewStore);
	private readonly api = inject(OpeningExplorerService);
	private readonly notify = inject(NotificationService);
	private readonly tabs = inject(TabsStore);
	private readonly pgn = inject(PgnParserService);
	private readonly tree = inject(MoveTreeStore);
	private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

	readonly columns: readonly ColumnDefinition[] = [
		{ key: 'WHITE_NAME', label: 'White', align: 'left' },
		{ key: 'WHITE_ELO', label: 'Elo', align: 'right' },
		{ key: 'RESULT', label: 'Result', align: 'center' },
		{ key: 'BLACK_NAME', label: 'Black', align: 'left' },
		{ key: 'BLACK_ELO', label: 'Elo', align: 'right' },
		{ key: 'DATE', label: 'Date', align: 'right' },
		{ key: 'EVENT', label: 'Event', align: 'left' },
	];

	readonly status = computed(() => this.store.status());
	readonly error = computed(() => this.store.error());
	readonly isEmpty = computed(() => this.store.isEmpty());
	readonly hasMore = computed(() => this.store.hasMore());

	readonly rows = computed<readonly RenderedGame[]>(() => this.store.rows().map(render));

	readonly openMenu = signal<OpenMenu | null>(null);

	readonly selectedId = computed(() => this.preview.game()?.id ?? null);

	constructor() {
		effect(() => this.preview.setRows(this.store.rows()));

		effect(() => {
			const id = this.selectedId();
			if (id === null) return;

			const row = this.host.nativeElement.querySelector<HTMLElement>(`tr[data-game-id="${id}"]`);
			row?.focus({ preventScroll: true });
			if (row) {
				const container = scrollableAncestor(row);
				if (container) scrollIntoContainer(container, row, { block: 'nearest', margin: ROW_CLEARANCE_PX });
			}
		});
	}

	ngOnDestroy(): void {
		this.preview.clear();
	}

	ariaSort(key: GameSortKey): 'ascending' | 'descending' | 'none' {
		if (this.store.sort() !== key) {
			return 'none';
		}
		return this.store.ascending() ? 'ascending' : 'descending';
	}

	sortBy(key: GameSortKey): void {
		this.store.sortBy(key);
	}

	loadMore(): void {
		this.store.loadMore();
	}

	selectGame(game: RenderedGame): void {
		const summary = this.store.rows().find((row) => row.id === game.id);
		if (summary) {
			this.preview.select(summary);
		}
	}

	onContextMenu(event: MouseEvent, game: RenderedGame): void {
		event.preventDefault();
		// Without this, the event bubbles to the document:contextmenu listener that closes the menu.
		event.stopPropagation();

		const row = event.currentTarget as HTMLElement;
		this.openMenu.set({ game, anchor: row.getBoundingClientRect() });
	}

	@HostListener('document:click')
	@HostListener('document:contextmenu')
	@HostListener('window:blur')
	closeMenu(): void {
		this.openMenu.set(null);
	}

	@HostListener('document:keydown.escape')
	onEscape(): void {
		this.closeMenu();
	}

	openInNewTab(game: RenderedGame): void {
		this.closeMenu();
		this.tabs.openElsewhere(`/analysis?game=${game.id}`);
	}

	addToAnalysis(game: RenderedGame): void {
		this.closeMenu();
		this.api.game(game.id).subscribe({
			next: (detail) => this.graft(detail, game),
			error: (err: Error) => this.notify.error(err.message),
		});
	}

	private graft(detail: GameDetail, row: RenderedGame): void {
		const parsed = this.pgn.parse(detail.pgn);

		const mainline: PlyNode[] = [];
		let walker: MoveNode = parsed.root;
		while (walker.children.length > 0) {
			walker = walker.children[0];
			mainline.push(walker);
		}

		const anchor = this.tree.currentNode();
		const target = position(anchor.fen);

		// Matched on the position, not on the ply the row reports.
		let start = position(parsed.root.fen) === target ? 0 : -1;
		if (start < 0) {
			const index = mainline.findIndex((ply) => position(ply.fen) === target);
			if (index >= 0) start = index + 1;
		}
		if (start < 0 || start >= mainline.length) {
			return;
		}

		let last: MoveNode = anchor;
		for (let i = start; i < mainline.length; i++) {
			const ply = mainline[i];
			// Reuses an existing child that already ends in the same position.
			last = this.tree.addMove({
				from: ply.from,
				to: ply.to,
				piece: ply.piece,
				color: ply.color,
				san: ply.san,
				fen: ply.fen,
				promotion: ply.promotion,
			});
		}

		this.tree.setComment(last, row.comment);

		// addMove walks the cursor forward as it appends; put it back.
		this.tree.select(anchor);
	}
}

// Placement, side to move, castling and en passant - a position without the move counters.
function position(fen: string): string {
	return fen.split(' ').slice(0, 4).join(' ');
}

function render(game: GameSummary): RenderedGame {
	const date = formatDate(game.date, game.year);
	const white = `${game.white}${game.whiteElo ? ` ${game.whiteElo}` : ''}`;
	const black = `${game.black}${game.blackElo ? ` ${game.blackElo}` : ''}`;

	return {
		id: game.id,
		white: game.white,
		whiteElo: game.whiteElo ? `${game.whiteElo}` : '',
		result: game.result,
		black: game.black,
		blackElo: game.blackElo ? `${game.blackElo}` : '',
		date,
		event: game.event ?? '',
		comment: `${white} – ${black}, ${game.result}${game.year ? `, ${game.year}` : ''}`,
		label: `${game.white} versus ${game.black}, ${game.result}${date ? `, ${date}` : ''}`,
	};
}

function formatDate(iso: string | null, year: number | null): string {
	if (iso) {
		return iso.replace(/-/g, '.');
	}
	return year ? `${year}` : '';
}
