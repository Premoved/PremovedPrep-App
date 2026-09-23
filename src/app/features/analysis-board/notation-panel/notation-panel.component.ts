import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	OnDestroy,
	computed,
	effect,
	inject,
	input,
	output,
	signal,
	viewChild,
	viewChildren,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ViewportService } from '../../../core/layout/viewport.service';
import { UciMove } from '../../../core/engine/uci';
import { MoveNode } from '../../../core/models/move-node.model';
import { EngineStore } from '../state/engine.store';
import { DatabaseBadgeComponent } from '../../../shared/database-badge/database-badge.component';
import { GameListStore } from '../state/game-list.store';
import { OpeningExplorerStore } from '../state/opening-explorer.store';
import { ReportStore } from '../state/report.store';
import { EngineBarComponent } from './engine-bar/engine-bar.component';
import { EngineLinesComponent } from './engine-lines/engine-lines.component';
import { EngineSettingsComponent } from './engine-settings/engine-settings.component';
import { TablebasePanelComponent } from './tablebase-panel/tablebase-panel.component';
import { GameHeaderComponent } from './game-header/game-header.component';
import { GameListComponent } from './game-list/game-list.component';
import { MoveTreeComponent } from './move-tree/move-tree.component';
import { OpeningTreeComponent } from './opening-tree/opening-tree.component';
import { ReportBarComponent } from './report-bar/report-bar.component';
import { FrameResizeObserver } from '../../../core/browser/frame-resize-observer';

export type NotationTab = 'notation' | 'openings' | 'games';

interface TabDefinition {
	readonly id: NotationTab;
	readonly label: string;
}

const ALL_TABS: readonly TabDefinition[] = [
	{ id: 'notation', label: 'Notation' },
	{ id: 'openings', label: 'Openings Book' },
	{ id: 'games', label: 'Games list' },
];

const PLAYER_TABS: readonly TabDefinition[] = [{ id: 'openings', label: "Player's Opening Tree" }];

const REPORT_TABS: readonly TabDefinition[] = [{ id: 'notation', label: 'Advanced Report' }];

@Component({
	selector: 'app-notation-panel',
	standalone: true,
	imports: [
		NgTemplateOutlet,
		EngineBarComponent,
		EngineLinesComponent,
		EngineSettingsComponent,
		TablebasePanelComponent,
		DatabaseBadgeComponent,
		GameHeaderComponent,
		GameListComponent,
		MoveTreeComponent,
		OpeningTreeComponent,
		ReportBarComponent,
	],
	templateUrl: './notation-panel.component.html',
	styleUrl: './notation-panel.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotationPanelComponent implements AfterViewInit, OnDestroy {
	readonly viewport = inject(ViewportService);

	private readonly tabOverride = signal<NotationTab | null>(null);

	readonly activeTab = computed<NotationTab>(() => {
		if (this.reportMode()) {
			return 'notation';
		}
		if (this.openingTreeOnly()) {
			return 'openings';
		}
		return this.tabOverride() ?? 'notation';
	});

	readonly openingTreeOnly = input(false);

	readonly scopeLabel = input('');

	readonly reportMode = input(false);

	readonly report = inject(ReportStore);

	readonly settingsOpen = signal(false);

	readonly tablebaseOpen = signal(false);

	readonly engine = inject(EngineStore);

	private readonly explorer = inject(OpeningExplorerStore);

	private readonly gameList = inject(GameListStore);

	readonly showsDatabase = computed(() => this.activeTab() === 'openings' || this.activeTab() === 'games');

	readonly tabs = computed<readonly TabDefinition[]>(() => {
		if (this.reportMode()) {
			return REPORT_TABS;
		}
		return this.openingTreeOnly() ? PLAYER_TABS : ALL_TABS;
	});

	readonly minWidthMeasured = output<number>();

	readonly moveSelected = output<MoveNode>();
	readonly positionChanged = output<void>();

	readonly engineMoveRequested = output<UciMove>();

	readonly explorerMoveRequested = output<UciMove>();

	private readonly tabStrip = viewChild.required<ElementRef<HTMLElement>>('tabStrip');

	private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

	private tabObserver?: FrameResizeObserver;
	private lastMinWidth = 0;

	constructor() {
		// Each database-backed tab only queries while it is showing.
		effect(() => {
			const tab = this.activeTab();
			this.explorer.setActive(tab === 'openings');
			this.gameList.setActive(tab === 'games');
		});
	}

	ngAfterViewInit(): void {
		// Observing the tabs, not the strip: the strip is stretched by its container.
		this.tabObserver = new FrameResizeObserver(() => this.measure());
		for (const tab of this.tabButtons()) {
			this.tabObserver.observe(tab.nativeElement);
		}
	}

	ngOnDestroy(): void {
		this.tabObserver?.disconnect();
	}

	private measure(): void {
		const tabs = this.tabButtons();
		if (tabs.length === 0) {
			return;
		}

		const style = getComputedStyle(this.tabStrip().nativeElement);
		const gap = parseFloat(style.columnGap) || 0;
		const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
		const labels = tabs.reduce((total, tab) => total + tab.nativeElement.getBoundingClientRect().width, 0);

		// Rounded up: half a pixel short of the requirement still clips.
		const min = Math.ceil(labels + gap * (tabs.length - 1) + padding);
		if (min !== this.lastMinWidth) {
			this.lastMinWidth = min;
			this.minWidthMeasured.emit(min);
		}
	}

	select(id: NotationTab): void {
		this.tabOverride.set(id);
	}

	// A click that lands on the panel's own background (not a row) would otherwise focus this
	// tabindex="0" div and show its ring; keyboard users still reach it by tabbing in.
	onTabContentMouseDown(event: MouseEvent): void {
		if (event.target === event.currentTarget) {
			event.preventDefault();
		}
	}

	onTabKeydown(event: KeyboardEvent, index: number): void {
		const last = this.tabs().length - 1;
		let next: number;

		switch (event.key) {
			case 'ArrowRight':
				next = index === last ? 0 : index + 1;
				break;
			case 'ArrowLeft':
				next = index === 0 ? last : index - 1;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = last;
				break;
			default:
				return;
		}

		event.preventDefault();
		event.stopPropagation();
		this.tabOverride.set(this.tabs()[next].id);
		this.tabButtons()[next]?.nativeElement.focus();
	}
}
