import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	effect,
	inject,
	input,
	signal,
	untracked,
	viewChild,
} from '@angular/core';
import { UciMove } from '../../../core/engine/uci';
import { OpponentScope } from '../../../core/models/search.model';
import { ChessBoardComponent } from '../../analysis-board/chess-board/chess-board.component';
import { EngineBarComponent } from '../../analysis-board/notation-panel/engine-bar/engine-bar.component';
import { EngineLinesComponent } from '../../analysis-board/notation-panel/engine-lines/engine-lines.component';
import { EngineSettingsComponent } from '../../analysis-board/notation-panel/engine-settings/engine-settings.component';
import { TablebasePanelComponent } from '../../analysis-board/notation-panel/tablebase-panel/tablebase-panel.component';
import { GameHeaderComponent } from '../../analysis-board/notation-panel/game-header/game-header.component';
import { OpeningTreeComponent } from '../../analysis-board/notation-panel/opening-tree/opening-tree.component';
import { EngineStore } from '../../analysis-board/state/engine.store';
import { TablebaseStore } from '../../analysis-board/state/tablebase.store';
import { GamePreviewStore } from '../../analysis-board/state/game-preview.store';
import { MoveTreeStore } from '../../analysis-board/state/move-tree.store';
import { OpeningExplorerStore } from '../../analysis-board/state/opening-explorer.store';
import { ViewportService } from '../../../core/layout/viewport.service';

const MIN_TREE_PX = 320;
const DEFAULT_TREE_PX = 420;

const HANDLE_MARGIN_PX = 24;

@Component({
	selector: 'app-opponent-explorer',
	standalone: true,
	imports: [
		ChessBoardComponent,
		OpeningTreeComponent,
		GameHeaderComponent,
		EngineBarComponent,
		EngineLinesComponent,
		EngineSettingsComponent,
		TablebasePanelComponent,
	],
	templateUrl: './opponent-explorer.component.html',
	styleUrl: './opponent-explorer.component.scss',
	providers: [MoveTreeStore, EngineStore, TablebaseStore, OpeningExplorerStore, GamePreviewStore],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpponentExplorerComponent implements AfterViewInit {
	private readonly explorer = inject(OpeningExplorerStore);
	readonly viewport = inject(ViewportService);

	readonly engine = inject(EngineStore);

	readonly scope = input<OpponentScope | null>(null);

	readonly board = viewChild<ChessBoardComponent>('board');

	readonly settingsOpen = signal(false);

	readonly tablebaseOpen = signal(false);

	constructor() {
		effect(() => this.explorer.setScope(this.scope()));

		effect(() => {
			const scope = this.scope();
			const board = this.board();
			if (!scope || !board) {
				return;
			}
			const wanted = scope.color === 'w' ? 'black' : 'white';
			untracked(() => board.setOrientation(wanted));
		});

		effect(() => this.board()?.setAutoShapes(this.engine.boardShapes()));
	}

	ngAfterViewInit(): void {
		this.explorer.setActive(true);
	}

	playMove(move: UciMove): void {
		this.board()?.executeMove(move.from, move.to, move.promotion ?? 'q');
	}

	readonly treeWidth = signal(DEFAULT_TREE_PX);
	readonly resizing = signal(false);
	readonly handleOffset = signal<number | null>(null);
	readonly handleActive = signal(false);

	startResize(event: PointerEvent): void {
		event.preventDefault();
		this.resizing.set(true);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onResize(event: PointerEvent, row: HTMLElement): void {
		if (!this.resizing()) {
			return;
		}
		const rect = row.getBoundingClientRect();
		const width = rect.right - event.clientX;
		this.treeWidth.set(Math.min(Math.max(width, MIN_TREE_PX), Math.max(rect.width / 2, MIN_TREE_PX)));
	}

	stopResize(): void {
		this.resizing.set(false);
	}

	onHandlePointerDown(event: PointerEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.handleActive.set(true);
		this.resizing.set(true);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onHandleDrag(event: PointerEvent, row: HTMLElement): void {
		if (!this.handleActive()) {
			return;
		}
		this.onResize(event, row);
		const rect = row.getBoundingClientRect();
		const y = event.clientY - rect.top;
		this.handleOffset.set(
			Math.min(Math.max(y, HANDLE_MARGIN_PX), Math.max(rect.height - HANDLE_MARGIN_PX, HANDLE_MARGIN_PX)),
		);
	}

	onHandlePointerUp(): void {
		this.handleActive.set(false);
		this.resizing.set(false);
	}
}
