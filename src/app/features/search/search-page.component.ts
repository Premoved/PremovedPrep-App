import { AfterViewInit, ChangeDetectionStrategy, Component, effect, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SearchColor } from '../../core/models/search.model';
import { SeoService } from '../../core/seo/seo.service';
import { fideIdFromSlug, opponentSearchPath } from '../../core/seo/opponent-page';
import { AdvancedSearchComponent } from './advanced-search/advanced-search.component';
import { OpponentSearchComponent } from './opponent-search/opponent-search.component';
import { DatabaseBadgeComponent } from '../../shared/database-badge/database-badge.component';

export type SearchTab = 'opponent' | 'advanced';

@Component({
	selector: 'app-search-page',
	standalone: true,
	imports: [OpponentSearchComponent, AdvancedSearchComponent, DatabaseBadgeComponent],
	templateUrl: './search-page.component.html',
	styleUrl: './search-page.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchPageComponent implements AfterViewInit {
	private readonly route = inject(ActivatedRoute);
	private readonly seo = inject(SeoService);

	private readonly opponentSearch = viewChild(OpponentSearchComponent);

	readonly tab = signal<SearchTab>('opponent');

	readonly tabs: readonly { id: SearchTab; label: string }[] = [
		{ id: 'opponent', label: 'Search opponent' },
		{ id: 'advanced', label: 'Advanced search' },
	];

	private wanted: number | null = null;

	constructor() {
		effect(() => {
			const player = this.opponentSearch()?.profile();
			// Only for the player this page was opened for; searching someone else leaves the title alone.
			if (!player || player.fideId !== this.wanted) {
				return;
			}
			const name = player.name;
			const games = `${player.archiveGames} game${player.archiveGames === 1 ? '' : 's'}`;
			this.seo.describe(
				`${name} - chess games and preparation`,
				`${games} by ${name} in the PremovedPrep archive: an all-in-one chess tool for analysis, ` +
					`exploring database games, studying opponents and building repertoires.`,
				opponentSearchPath(name, player.fideId),
			);
		});
	}

	// Reads the route once from the snapshot rather than subscribing: reacting to every param
	// change would fight a later search for someone else.
	ngAfterViewInit(): void {
		const slug = this.route.snapshot.paramMap.get('slug');
		const fideId = slug === null ? null : fideIdFromSlug(slug);
		if (fideId === null) {
			return;
		}

		const colour = this.route.snapshot.queryParamMap.get('color');
		const color: SearchColor | null = colour === 'w' || colour === 'b' ? colour : null;

		this.wanted = fideId;
		this.tab.set('opponent');
		this.opponentSearch()?.openFor(fideId, color);
	}

	select(tab: SearchTab): void {
		this.tab.set(tab);
	}
}
