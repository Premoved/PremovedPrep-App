import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { BishopLogoComponent } from '../../shared/logo/bishop-logo.component';
import { KingLogoComponent } from '../../shared/logo/king-logo.component';
import { KnightLogoComponent } from '../../shared/logo/knight-logo.component';
import { PawnLogoComponent } from '../../shared/logo/pawn-logo.component';
import { QueenLogoComponent } from '../../shared/logo/queen-logo.component';
import { RookLogoComponent } from '../../shared/logo/rook-logo.component';

@Component({
	selector: 'app-collection-icon',
	standalone: true,
	imports: [
		PawnLogoComponent,
		KnightLogoComponent,
		BishopLogoComponent,
		RookLogoComponent,
		QueenLogoComponent,
		KingLogoComponent,
	],
	template: `
		@switch (icon()) {
			@case ('pawn') {
				<app-pawn-logo class="icon-style"></app-pawn-logo>
			}
			@case ('knight') {
				<app-knight-logo class="icon-style"></app-knight-logo>
			}
			@case ('bishop') {
				<app-bishop-logo class="icon-style"></app-bishop-logo>
			}
			@case ('rook') {
				<app-rook-logo class="icon-style"></app-rook-logo>
			}
			@case ('queen') {
				<app-queen-logo class="icon-style"></app-queen-logo>
			}
			@case ('king') {
				<app-king-logo class="icon-style"></app-king-logo>
			}
			@case ('book') {
				<svg class="glyph book" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path
						d="M6 2h11a3 3 0 0 1 3 3v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 2v14h12V5a1 1 0 0 0-1-1H6Zm2 2h7v2H8V6Zm0 4h7v2H8v-2Z"
					/>
				</svg>
			}
			@default {
				<svg class="glyph folder" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />
				</svg>
			}
		}
	`,
	styles: [
		`
			:host {
				display: flex;
				align-items: center;
				justify-content: center;
			}

			app-pawn-logo,
			app-knight-logo,
			app-bishop-logo,
			app-rook-logo,
			app-queen-logo,
			app-king-logo {
				width: 100%;
				height: 100%;
			}

			/** Ensures consistent optical sizing and visual weight across all collection icons */
			.glyph {
				width: 74%;
				height: 74%;
			}

			.glyph.folder {
				width: 61%;
				height: 61%;
			}
		`,
	],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CollectionIconComponent {
	readonly icon = input.required<string>();
}
