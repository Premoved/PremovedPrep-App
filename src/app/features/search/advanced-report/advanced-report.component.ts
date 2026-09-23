import {
	ChangeDetectionStrategy,
	Component,
	computed,
	effect,
	inject,
	input,
	signal,
	untracked,
	viewChild,
} from '@angular/core';
import { MoveNode } from '../../../core/models/move-node.model';
import { OpponentScope } from '../../../core/models/search.model';
import { ReportApiService } from '../../../core/services/report-api.service';
import { ChessBoardComponent } from '../../analysis-board/chess-board/chess-board.component';
import { EngineBarComponent } from '../../analysis-board/notation-panel/engine-bar/engine-bar.component';
import { EngineLinesComponent } from '../../analysis-board/notation-panel/engine-lines/engine-lines.component';
import { EngineSettingsComponent } from '../../analysis-board/notation-panel/engine-settings/engine-settings.component';
import { TablebasePanelComponent } from '../../analysis-board/notation-panel/tablebase-panel/tablebase-panel.component';
import { MoveTreeComponent } from '../../analysis-board/notation-panel/move-tree/move-tree.component';
import { ReportBarComponent } from '../../analysis-board/notation-panel/report-bar/report-bar.component';
import { EngineStore } from '../../analysis-board/state/engine.store';
import { TablebaseStore } from '../../analysis-board/state/tablebase.store';
import { GamePreviewStore } from '../../analysis-board/state/game-preview.store';
import { MoveTreeStore } from '../../analysis-board/state/move-tree.store';
import { ReportStore } from '../../analysis-board/state/report.store';
import { UciMove } from '../../../core/engine/uci';
import { ViewportService } from '../../../core/layout/viewport.service';
import { AnalyticsService } from '../../../core/analytics/analytics.service';
import { AnalyticsEvent } from '../../../core/analytics/analytics.events';
import { AuthService } from '../../../core/services/auth.service';
import { AdvancedReportCache, scopeKey } from './advanced-report-cache';

const MIN_TREE_PX = 340;
const DEFAULT_TREE_PX = 460;

const HANDLE_MARGIN_PX = 24;

export type ReportStatus = 'idle' | 'loading' | 'ready' | 'error';

@Component({
	selector: 'app-advanced-report',
	standalone: true,
	imports: [
		ChessBoardComponent,
		MoveTreeComponent,
		ReportBarComponent,
		EngineBarComponent,
		EngineLinesComponent,
		EngineSettingsComponent,
		TablebasePanelComponent,
	],
	templateUrl: './advanced-report.component.html',
	styleUrl: './advanced-report.component.scss',
	providers: [MoveTreeStore, GamePreviewStore, EngineStore, TablebaseStore, ReportStore],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdvancedReportComponent {
	private readonly api = inject(ReportApiService);
	private readonly auth = inject(AuthService);
	private readonly analytics = inject(AnalyticsService);
	readonly viewport = inject(ViewportService);
	private readonly tree = inject(MoveTreeStore);
	// Coming back to this panel with the same scope does not regenerate the report.
	private readonly cache = inject(AdvancedReportCache, { optional: true });

	readonly report = inject(ReportStore);
	readonly engine = inject(EngineStore);

	readonly scope = input<OpponentScope | null>(null);

	readonly board = viewChild<ChessBoardComponent>('board');

	readonly settingsOpen = signal(false);

	readonly tablebaseOpen = signal(false);

	readonly status = signal<ReportStatus>('idle');
	readonly error = signal<string | null>(null);

	readonly emptyReason = computed<string | null>(() => {
		const data = this.report.report();
		if (this.status() !== 'ready' || !data) {
			return null;
		}
		if (data.repertoireFiles === 0) {
			const colour = data.repertoireColor === 'w' ? 'White' : 'Black';
			return `No main lines in your ${colour} repertoire yet — there is nothing to lay over their games.`;
		}
		if (data.gamesRead === 0) {
			return 'No games for this player in the archive, so there is nothing to overlap.';
		}
		if (data.overlaps === 0 && data.deviations === 0) {
			return 'None of their games follow a line in your repertoire.';
		}
		return null;
	});

	readonly hasTree = computed(() => this.status() === 'ready' && this.emptyReason() === null);

	// Guards the fetch effect against re-running for the same scope.
	private requested?: string;

	constructor() {
		effect(() => {
			const scope = this.scope();
			const board = this.board();
			if (!scope || !board) {
				return;
			}
			const key = scopeKey(scope);
			if (this.requested === key) {
				return;
			}
			this.requested = key;
			untracked(() => this.load(board));
		});

		effect(() => {
			const scope = this.scope();
			const board = this.board();
			if (!scope || !board) {
				return;
			}
			const wanted = scope.color === 'w' ? 'black' : 'white';
			untracked(() => board.setOrientation(wanted));
		});

		effect(() => {
			this.board()?.setAutoShapes([...this.engine.boardShapes(), ...this.report.boardShapes()]);
		});

		effect(() => {
			this.tree.currentNode();
			this.tree.revision();
			untracked(() => this.report.syncToCursor());
		});
	}

	private load(board: ChessBoardComponent): void {
		const scope = this.scope();
		if (!scope) {
			return;
		}
		this.error.set(null);

		const kept = this.cache?.get(scope);
		if (kept) {
			this.report.build(kept);
			board.refresh();
			this.status.set('ready');
			return;
		}

		this.status.set('loading');
		this.api.advanced(scope).subscribe({
			next: (data) => {
				this.cache?.set(scope, data);
				this.report.build(data);
				board.refresh();
				this.status.set('ready');
				this.analytics.capture(AnalyticsEvent.advancedReportViewed, {
					authenticated: this.auth.isAuthenticated(),
					overlaps: data?.overlaps ?? 0,
					deviations: data?.deviations ?? 0,
					games_read: data?.gamesRead ?? 0,
					repertoire_files: data?.repertoireFiles ?? 0,
				});
			},
			error: (err: Error) => {
				this.report.build(null);
				this.error.set(err.message);
				this.status.set('error');
			},
		});
	}

	selectNode(node: MoveNode): void {
		this.board()?.selectMove(node);
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
