import { Router } from '@angular/router';
import { TabsStore } from '../../../core/tabs/tabs.store';
import {
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	computed,
	effect,
	inject,
	signal,
	viewChild,
} from '@angular/core';
import {
	OpponentScope,
	PlayerProfile,
	PlayerSuggestion,
	SearchColor,
	SearchResultGame,
	SearchSortKey,
	fideFederationUrl,
	fideProfileUrl,
} from '../../../core/models/search.model';
import { NotificationService } from '../../../core/services/notification.service';
import { isOffline } from '../../../core/browser/offline';
import { AnalyticsService } from '../../../core/analytics/analytics.service';
import { AnalyticsEvent } from '../../../core/analytics/analytics.events';
import { AuthService } from '../../../core/services/auth.service';
import { AgentSelectionStore } from '../../../core/agent/agent-selection.store';
import { SearchApiService } from '../../../core/services/search-api.service';
import { DatePickerComponent } from '../../../shared/date-picker/date-picker.component';
import { AdvancedReportComponent } from '../advanced-report/advanced-report.component';
import { AdvancedReportCache } from '../advanced-report/advanced-report-cache';
import { GameResultsComponent } from '../game-results/game-results.component';
import { OpponentExplorerComponent } from '../opponent-explorer/opponent-explorer.component';
import { ViewportService } from '../../../core/layout/viewport.service';

const SUGGEST_DEBOUNCE_MS = 220;
const OFFLINE =
	'No internet connection. Searching opponents requires player profiling from the cloud. ' +
	'Use Advanced search to query your local database offline.';

const MIN_QUERY_LENGTH = 2;

export type ResultPanel = 'games' | 'tree' | 'report';

@Component({
	selector: 'app-opponent-search',
	standalone: true,
	imports: [GameResultsComponent, DatePickerComponent, OpponentExplorerComponent, AdvancedReportComponent],
	providers: [AdvancedReportCache],
	templateUrl: './opponent-search.component.html',
	styleUrl: './opponent-search.component.scss',
	host: {
		'(document:click)': 'closeSuggestions()',
	},
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpponentSearchComponent {
	private readonly api = inject(SearchApiService);
	private readonly router = inject(Router);
	private readonly tabs = inject(TabsStore);
	private readonly notify = inject(NotificationService);
	private readonly viewport = inject(ViewportService);
	private readonly selection = inject(AgentSelectionStore);
	private readonly auth = inject(AuthService);
	private readonly analytics = inject(AnalyticsService);

	private readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('queryInput');

	readonly query = signal('');
	readonly suggestions = signal<readonly PlayerSuggestion[]>([]);
	readonly suggestionsOpen = signal(false);
	readonly highlighted = signal(0);
	private suggestTimer: ReturnType<typeof setTimeout> | null = null;
	private suggestRequestId = 0;

	readonly picked = signal<PlayerSuggestion | null>(null);

	readonly color = signal<SearchColor>('w');

	readonly from = signal('');

	readonly profile = signal<PlayerProfile | null>(null);
	readonly rows = signal<readonly SearchResultGame[]>([]);
	readonly loading = signal(false);
	readonly hasMore = signal(false);
	readonly searched = signal(false);
	readonly sort = signal<SearchSortKey>('DATE');
	readonly ascending = signal(false);
	private page = 0;

	readonly scope = signal<OpponentScope | null>(null);

	readonly previewRows = signal<readonly SearchResultGame[]>([]);
	readonly previewLoading = signal(false);

	constructor() {
		effect(() => {
			this.selection.database();
			this.loadPreview();
		});
	}

	readonly canSearch = computed(() => !this.loading());

	readonly resultsPlaceholder = 'No games in the archive match this search.';

	readonly hasResults = computed(() => this.scope() !== null);

	readonly panel = signal<ResultPanel>('games');

	readonly panels: readonly { id: ResultPanel; label: string }[] = [
		{ id: 'games', label: 'Games list' },
		{ id: 'tree', label: "Player's Opening Tree" },
		{ id: 'report', label: 'Advanced report' },
	];

	selectPanel(panel: ResultPanel): void {
		this.panel.set(panel);
	}

	openGuide(event: Event): void {
		event.stopPropagation();
		const url = this.router.serializeUrl(this.router.createUrlTree(['/'], { fragment: 'database-search' }));
		this.tabs.openElsewhere(url);
	}

	readonly collapsible = computed(() => !this.viewport.isMobile());

	private readonly foldRequested = signal(false);

	readonly barCollapsed = computed(() => this.collapsible() && this.foldRequested());
	readonly handleOffset = signal<number | null>(null);
	readonly handleDragging = signal(false);
	private dragStartX = 0;
	private dragMoved = false;

	startHandleDrag(event: PointerEvent): void {
		event.preventDefault();
		this.handleDragging.set(true);
		this.dragMoved = false;
		this.dragStartX = event.clientX;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	onHandleDrag(event: PointerEvent, bar: HTMLElement): void {
		if (!this.handleDragging()) {
			return;
		}
		if (Math.abs(event.clientX - this.dragStartX) > 3) {
			this.dragMoved = true;
		}
		const rect = bar.getBoundingClientRect();
		const margin = 24;
		const x = Math.min(Math.max(event.clientX - rect.left, margin), Math.max(rect.width - margin, margin));
		this.handleOffset.set(x);
	}

	stopHandleDrag(): void {
		if (!this.handleDragging()) {
			return;
		}
		this.handleDragging.set(false);
		if (!this.dragMoved) {
			this.foldRequested.update((collapsed) => !collapsed);
		}
	}

	onQuery(event: Event): void {
		const value = (event.target as HTMLInputElement).value;
		this.query.set(value);
		this.picked.set(null);

		if (this.suggestTimer !== null) {
			clearTimeout(this.suggestTimer);
		}
		const trimmed = value.trim();
		if (trimmed.length < MIN_QUERY_LENGTH) {
			this.suggestions.set([]);
			this.suggestionsOpen.set(false);
			return;
		}
		this.suggestTimer = setTimeout(() => this.fetchSuggestions(trimmed), SUGGEST_DEBOUNCE_MS);
	}

	private fetchSuggestions(query: string): void {
		const request = ++this.suggestRequestId;
		this.api.suggestPlayers(query).subscribe({
			next: (list) => {
				// Drops the response if a newer request has since started.
				if (request !== this.suggestRequestId) return;
				this.suggestions.set(list);
				this.highlighted.set(0);
				this.suggestionsOpen.set(list.length > 0);
			},
			error: () => {
				if (request !== this.suggestRequestId) return;
				this.suggestions.set([]);
				this.suggestionsOpen.set(false);
			},
		});
	}

	onQueryKeydown(event: KeyboardEvent): void {
		if (!this.suggestionsOpen() || this.suggestions().length === 0) {
			if (event.key === 'Enter' && this.picked()) {
				this.search();
				event.preventDefault();
			}
			return;
		}

		const count = this.suggestions().length;
		switch (event.key) {
			case 'ArrowDown':
				this.highlighted.update((index) => (index + 1) % count);
				event.preventDefault();
				break;
			case 'ArrowUp':
				this.highlighted.update((index) => (index - 1 + count) % count);
				event.preventDefault();
				break;
			case 'Enter':
				this.pick(this.suggestions()[this.highlighted()]);
				event.preventDefault();
				break;
			case 'Escape':
				this.closeSuggestions();
				event.preventDefault();
				break;
			default:
				break;
		}
	}

	openFor(fideId: number, color: SearchColor | null): void {
		if (color) {
			this.color.set(color);
		}
		// Resolves by id rather than the name autocomplete, which searches text and could match someone else.
		this.api.playerProfile(fideId).subscribe({
			next: (profile) => {
				const player: PlayerSuggestion = {
					fideId: profile.fideId,
					name: profile.name,
					federation: profile.federation,
					title: profile.title,
					standardRating: profile.standardRating,
				};
				this.pick(player);
				this.runFor(player);
			},
			error: (err: unknown) =>
				this.notify.error(isOffline(err) ? OFFLINE : 'That player could not be found in the archive.'),
		});
	}

	pick(suggestion: PlayerSuggestion): void {
		this.picked.set(suggestion);
		this.query.set(describe(suggestion));
		this.closeSuggestions();
		this.queryInput()?.nativeElement.focus();
	}

	closeSuggestions(): void {
		this.suggestionsOpen.set(false);
	}

	keepOpen(event: Event): void {
		event.stopPropagation();
	}

	selectColor(color: SearchColor): void {
		if (this.color() === color) {
			return;
		}
		this.color.set(color);
		if (this.scope()) {
			this.search();
		}
	}

	setFrom(value: string): void {
		this.from.set(value);
		if (this.scope()) {
			this.search();
		}
	}

	search(): void {
		const player = this.picked();
		if (player) {
			this.runFor(player);
			return;
		}

		const query = resolvableQuery(this.query());
		if (query.length < MIN_QUERY_LENGTH) {
			this.notify.error('Type a name or a FIDE id to search for.');
			return;
		}

		this.loading.set(true);
		this.closeSuggestions();
		this.api.suggestPlayers(query, 1).subscribe({
			next: (list) => {
				this.loading.set(false);
				if (list.length === 0) {
					this.notify.error(`No player in the FIDE list matches “${query}”.`);
					return;
				}

				this.picked.set(list[0]);
				this.query.set(describe(list[0]));
				this.runFor(list[0]);
			},
			error: (err: Error) => {
				this.loading.set(false);
				this.notify.error(isOffline(err) ? OFFLINE : err.message);
			},
		});
	}

	private runFor(player: PlayerSuggestion): void {
		this.analytics.capture(AnalyticsEvent.opponentSearch, {
			mode: 'opponent',
			authenticated: this.auth.isAuthenticated(),
			source: this.selection.usingLocalDatabase() ? 'local' : 'cloud',
			color: this.color(),
		});
		this.scope.set({
			fideId: player.fideId,
			color: this.color(),
			from: this.from().trim() || null,
			to: null,
			name: player.name,
		});
		this.page = 0;
		this.rows.set([]);
		this.loadProfile(player.fideId);
		this.load(false);
	}

	private loadProfile(fideId: number): void {
		this.api.playerProfile(fideId).subscribe({
			next: (profile) => this.profile.set(profile),
			error: () => this.profile.set(null),
		});
	}

	onSort(key: SearchSortKey): void {
		if (this.loading() || this.previewLoading()) {
			return;
		}
		if (this.sort() === key) {
			this.ascending.update((value) => !value);
		} else {
			this.sort.set(key);
			this.ascending.set(key === 'WHITE_NAME' || key === 'BLACK_NAME' || key === 'EVENT' || key === 'ECO');
		}

		if (!this.scope()) {
			this.loadPreview();
			return;
		}

		this.page = 0;
		this.rows.set([]);
		this.load(false);
	}

	private previewRequestId = 0;

	private loadPreview(): void {
		this.previewLoading.set(true);

		// Guards against an older request's response landing after a newer preview load.
		const request = ++this.previewRequestId;

		this.api.recent(this.sort(), this.ascending()).subscribe({
			next: (result) => {
				if (request !== this.previewRequestId) return;
				this.previewRows.set(result.games);
				this.previewLoading.set(false);
			},
			error: () => {
				if (request !== this.previewRequestId) return;
				this.previewRows.set([]);
				this.previewLoading.set(false);
			},
		});
	}

	loadMore(): void {
		if (this.scope() && !this.loading()) {
			this.page++;
			this.load(true);
		}
	}

	private loadRequestId = 0;

	private load(append: boolean): void {
		const scope = this.scope();
		if (!scope) {
			return;
		}
		this.loading.set(true);

		// Guards against an older request's response landing after a newer load.
		const request = ++this.loadRequestId;

		this.api
			.opponentGames(scope.fideId, scope.color, scope.from, scope.to, this.sort(), this.ascending(), this.page)
			.subscribe({
				next: (result) => {
					if (request !== this.loadRequestId) return;
					this.rows.update((current) => (append ? [...current, ...result.games] : result.games));
					this.hasMore.set(result.hasMore);
					this.loading.set(false);
					this.searched.set(true);
				},
				error: (err: Error) => {
					if (request !== this.loadRequestId) return;
					this.loading.set(false);
					this.searched.set(true);
					this.notify.error(err.message);
				},
			});
	}

	rating(value: number | null): string {
		return value === null || value === 0 ? 'unrated' : String(value);
	}

	born(profile: PlayerProfile): string {
		if (profile.birthYear === null) {
			return '—';
		}
		return profile.age === null ? String(profile.birthYear) : `${profile.birthYear} (${profile.age})`;
	}

	gender(profile: PlayerProfile): string {
		if (profile.sex === 'M') return 'Male';
		if (profile.sex === 'F') return 'Female';
		return '—';
	}

	fideUrl(profile: PlayerProfile): string {
		return fideProfileUrl(profile.fideId);
	}

	federationUrl(profile: PlayerProfile): string {
		return fideFederationUrl(profile.federation ?? '');
	}

	rank(value: number | null): string {
		return value === null || value === 0 ? '—' : String(value);
	}

	hasRanks(profile: PlayerProfile): boolean {
		return (
			profile.worldRankActive !== null ||
			profile.worldRankAll !== null ||
			profile.nationalRankActive !== null ||
			profile.nationalRankAll !== null
		);
	}
}

function describe(player: PlayerSuggestion): string {
	const parts = [String(player.fideId)];
	if (player.title) {
		parts.push(player.title);
	}
	parts.push(player.name);
	if (player.federation) {
		parts.push(player.federation);
	}
	parts.push(player.standardRating === null || player.standardRating === 0 ? 'unrated' : String(player.standardRating));
	return parts.join(' · ');
}

// The query field displays "id · title · name · federation · rating" (see describe below);
// only the id segment is re-resolved on search.
function resolvableQuery(raw: string): string {
	const [first] = raw.split('·');
	return first.trim();
}
