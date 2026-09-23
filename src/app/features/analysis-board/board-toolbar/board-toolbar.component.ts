import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { LocalOpenEntry } from '../../../core/agent/agent.models';
import { DEFAULT_FEN } from '../../../core/chess/fen.util';
import { formatGameDate } from '../../../core/chess/game-headers';
import { composePgnFile, pgnFileName } from '../../../core/chess/pgn-file';
import { PgnSerializerService } from '../../../core/chess/pgn-serializer.service';
import { NotificationService } from '../../../core/services/notification.service';
import { MoveTreeStore } from '../state/move-tree.store';
import { GameFileDialogComponent, GameFilePanel, SavedEntry } from './game-file-dialog.component';
import { fitOnScreen } from '../../../core/browser/menu-placement';

// Keeps mailto/wa.me links under typical browser URL length limits.
const MAX_SHARE_URL_TEXT = 1400;

const SHARE_MENU_FOOTPRINT = { width: 160, height: 116 };

@Component({
	selector: 'app-board-toolbar',
	standalone: true,
	imports: [GameFileDialogComponent],
	templateUrl: './board-toolbar.component.html',
	styleUrl: './board-toolbar.component.scss',
	host: {
		'(document:click)': 'closeShare()',
		'(document:keydown.escape)': 'closeShare()',
	},
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardToolbarComponent {
	private readonly tree = inject(MoveTreeStore);
	private readonly serializer = inject(PgnSerializerService);
	private readonly notify = inject(NotificationService);

	readonly hasPrevious = input(false);
	readonly hasNext = input(false);

	readonly openItemId = input<number | null>(null);

	readonly openLocalEntry = input<LocalOpenEntry | null>(null);

	readonly previousRequested = output<void>();
	readonly nextRequested = output<void>();

	readonly savedToCollection = output<SavedEntry>();

	readonly overlayOpened = output<void>();

	readonly shareOpen = signal(false);

	readonly filePanel = signal<GameFilePanel | null>(null);

	readonly summary = computed(() => {
		const headers = this.tree.headers();
		const meta = {
			eco: headers.eco ?? '',
			event: headers.event ?? '',
			site: headers.site ?? '',
			round: headers.round ?? '',
			date: formatGameDate(headers.date),
			annotator: headers.annotator ?? '',
		};

		if (headers.white || headers.black) {
			return {
				players: true,
				white: headers.white ?? '?',
				whiteElo: headers.whiteElo ?? '',
				black: headers.black ?? '?',
				blackElo: headers.blackElo ?? '',
				result: headers.result ?? '*',
				...meta,
			};
		}

		if (headers.event) {
			return {
				players: false,
				white: headers.event,
				whiteElo: '',
				black: '',
				blackElo: '',
				result: '',
				...meta,
				event: '',
			};
		}
		return null;
	});

	openFile(event: Event, panel: GameFilePanel): void {
		event.stopPropagation();
		this.open(panel);
	}

	closeFile(): void {
		this.filePanel.set(null);
	}

	openLocationPanel(): void {
		this.open('location');
	}

	openGameDataPanel(): void {
		this.open('data');
	}

	private open(panel: GameFilePanel): void {
		this.closeShare();
		this.filePanel.set(panel);
		this.overlayOpened.emit();
	}

	onSaved(entry: SavedEntry): void {
		this.filePanel.set(null);
		this.notify.info('Saved.');
		this.savedToCollection.emit(entry);
	}

	readonly sharePos = signal<{ x: number; y: number } | null>(null);

	toggleShare(event: Event): void {
		event.stopPropagation();
		const opening = !this.shareOpen();
		if (opening) {
			const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
			this.sharePos.set(fitOnScreen(rect.right - SHARE_MENU_FOOTPRINT.width, rect.bottom + 6, SHARE_MENU_FOOTPRINT));
		}
		this.shareOpen.set(opening);
	}

	closeShare(): void {
		this.shareOpen.set(false);
	}

	download(): void {
		this.closeShare();
		const pgn = this.pgn();
		if (!pgn) return;

		const url = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = `${pgnFileName(this.tree.headers())}.pgn`;
		link.click();
		URL.revokeObjectURL(url);
	}

	shareByEmail(): void {
		this.closeShare();
		const pgn = this.pgn();
		if (!pgn) return;

		const subject = pgnFileName(this.tree.headers()).replace(/-/g, ' ');
		if (pgn.length > MAX_SHARE_URL_TEXT) {
			this.downloadInstead('email');
			return;
		}
		window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(pgn)}`;
	}

	shareByWhatsapp(): void {
		this.closeShare();
		const pgn = this.pgn();
		if (!pgn) return;

		if (pgn.length > MAX_SHARE_URL_TEXT) {
			this.downloadInstead('WhatsApp');
			return;
		}
		window.open(`https://wa.me/?text=${encodeURIComponent(pgn)}`, '_blank', 'noopener');
	}

	private downloadInstead(channel: string): void {
		this.download();
		this.notify.info(
			`That game is too long to fit in a ${channel} message, so it was downloaded instead — attach the file.`,
		);
	}

	private pgn(): string {
		const root = this.tree.root();
		if (!root) {
			this.notify.error('There is nothing on the board to share yet.');
			return '';
		}
		return composePgnFile({
			headers: this.tree.headers(),
			startFen: root.fen ?? DEFAULT_FEN,
			movetext: this.serializer.movetext(root),
		});
	}
}
