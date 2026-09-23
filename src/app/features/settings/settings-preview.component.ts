import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	OnDestroy,
	computed,
	effect,
	inject,
	untracked,
	viewChild,
} from '@angular/core';
import { Chessground } from '@lichess-org/chessground';
import { Api } from '@lichess-org/chessground/api';
import { DrawShape } from '@lichess-org/chessground/draw';
import { Key } from '@lichess-org/chessground/types';
import { ARROW_SLOTS, arrowBrushes } from '../../core/models/preferences.model';
import { PreferencesStore } from '../../core/services/preferences.store';

const PREVIEW_FEN = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';

const PREVIEW_ARROWS: readonly (readonly [Key, Key])[] = [
	['f3', 'e5'],
	['b5', 'c6'],
	['d2', 'd4'],
	['h2', 'h4'],
];

const PREVIEW_SELECTED: Key = 'b5';
const PREVIEW_DESTS: readonly Key[] = ['a4', 'a6', 'c4', 'd3', 'c6', 'e2', 'f1'];

@Component({
	selector: 'app-settings-preview',
	standalone: true,
	template: '<div class="preview-board" [class.dests-dot]="moveDests() === \'dot\'" #host></div>',
	styles: [
		`
			:host {
				display: block;
				width: 100%;
				container-type: inline-size;
			}

			.preview-board {
				width: 100%;
				aspect-ratio: 1;
			}

			.preview-board ::ng-deep coords {
				font-size: 1.75cqw;
			}

			.preview-board ::ng-deep coords.ranks {
				left: 0.78cqw;
				top: -3.91cqw;
				width: 2.34cqw;
			}

			.preview-board ::ng-deep coords.files {
				bottom: -0.78cqw;
				left: 4.69cqw;
				height: 3.13cqw;
			}

			.preview-board ::ng-deep square.move-dest {
				background: radial-gradient(
					transparent 0%,
					transparent 80%,
					rgba(74, 106, 138, 0.3) 80%,
					rgba(74, 106, 138, 0.3) 100%
				) !important;
			}

			.preview-board.dests-dot ::ng-deep square.move-dest {
				background: radial-gradient(rgba(74, 106, 138, 0.4) 21%, rgba(0, 0, 0, 0) 22%) !important;
			}

			.preview-board.dests-dot ::ng-deep square.oc.move-dest {
				background: radial-gradient(
					transparent 0%,
					transparent 80%,
					rgba(74, 106, 138, 0.3) 80%,
					rgba(74, 106, 138, 0.3) 100%
				) !important;
			}
		`,
	],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPreviewComponent implements AfterViewInit, OnDestroy {
	private readonly prefs = inject(PreferencesStore);
	readonly moveDests = computed(() => this.prefs.moveDests());
	private readonly host = viewChild<ElementRef<HTMLElement>>('host');

	private api?: Api;

	constructor() {
		effect(() => {
			const coordinates = this.prefs.coordinates();
			const colours = this.prefs.arrowColors();
			// Read only to trigger a rebuild; build() itself doesn't use piece set or board theme.
			this.prefs.pieceSet();
			this.prefs.boardThemeId();

			untracked(() => this.build(coordinates, colours));
		});
	}

	ngAfterViewInit(): void {
		if (!this.api) {
			this.build(this.prefs.coordinates(), this.prefs.arrowColors());
		}
	}

	ngOnDestroy(): void {
		this.api?.destroy();
	}

	private build(coordinates: boolean, colours: readonly string[]): void {
		const element = this.host()?.nativeElement;
		if (!element) return;

		this.api?.destroy();
		element.innerHTML = '';

		this.api = Chessground(element, {
			fen: PREVIEW_FEN,
			orientation: 'white',
			viewOnly: true,
			coordinates,
			selected: PREVIEW_SELECTED,
			movable: {
				free: false,
				color: undefined,
				showDests: true,
				dests: new Map([[PREVIEW_SELECTED, [...PREVIEW_DESTS]]]),
			},
			drawable: {
				enabled: false,
				visible: true,
				brushes: arrowBrushes(colours),
				autoShapes: PREVIEW_ARROWS.map(([orig, dest], index): DrawShape => ({
					orig,
					dest,
					brush: ARROW_SLOTS[index].brush,
				})),
			},
		});
	}
}
