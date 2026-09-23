import {
	AfterViewInit,
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	EventEmitter,
	Input,
	Output,
	ViewChild,
	inject,
	signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import { Api } from '@lichess-org/chessground/api';
import { Config } from '@lichess-org/chessground/config';
import { Key, Pieces } from '@lichess-org/chessground/types';
import {
	CastlingRights,
	FULL_CASTLING_RIGHTS,
	NO_CASTLING_RIGHTS,
	castlingRightsFrom,
	castlingField,
	enPassantCandidates,
	findStructuralPositionError,
	isLoadableFen,
	isSideNotToMoveInCheck,
} from '../../../../core/chess/fen.util';
import { ViewportService } from '../../../../core/layout/viewport.service';
import { pieceCssClasses, roleFromLetter } from '../../../../core/chess/piece-codec';
import { PieceComponent } from '../../../../shared/chess/piece.component';

/** chessground's Config has no `pieces` field, but the API accepts one. */
type SetupConfig = Config & { pieces?: Pieces };

const ERROR_FLASH_MS = 2000;

@Component({
	selector: 'app-setup-board',
	standalone: true,
	imports: [NgTemplateOutlet, FormsModule, PieceComponent],
	templateUrl: './setup-board.component.html',
	styleUrl: './setup-board.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupBoardComponent implements AfterViewInit {
	readonly viewport = inject(ViewportService);

	@Input({ required: true }) initialFen = 'start';
	@Input() flipped = false;

	@Input() narrow = false;
	@Input() stickToBoardTop = false;
	@Input() bottomOffset: number | null = null;

	@Output() previewFen = new EventEmitter<string>();
	@Output() confirmed = new EventEmitter<string>();
	@Output() cancelled = new EventEmitter<void>();
	@Output() ready = new EventEmitter<number>();

	@ViewChild('gridContainerEl') private gridContainerRef?: ElementRef<HTMLElement>;

	private cgApi?: Api;

	protected readonly whitePieces = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP'] as const;
	protected readonly blackPieces = ['bK', 'bQ', 'bR', 'bB', 'bN', 'bP'] as const;

	// null means the eraser is selected.
	protected readonly selectedPiece = signal<string | null>(null);
	protected readonly turn = signal<'w' | 'b'>('w');
	protected readonly enPassantOptions = signal<string[]>(['-']);
	protected readonly error = signal(false);

	// Plain fields, not signals: both are [(ngModel)] targets.
	protected castling: CastlingRights = { ...NO_CASTLING_RIGHTS };
	protected enPassantSquare = '-';

	private isFlipped = false;

	get contentHeight(): number | null {
		const element = this.gridContainerRef?.nativeElement;
		return element ? element.getBoundingClientRect().height : null;
	}

	@ViewChild('boardEl') set boardContent(content: ElementRef<HTMLElement> | undefined) {
		if (content && !this.cgApi) {
			this.initBoard(content.nativeElement);
		}
	}

	ngAfterViewInit(): void {
		const height = this.contentHeight;
		if (height !== null) this.ready.emit(height);
	}

	private initBoard(element: HTMLElement): void {
		this.isFlipped = this.flipped;
		this.readFields(this.initialFen);
		this.cgApi = Chessground(element, {
			fen: this.initialFen,
			orientation: this.isFlipped ? 'black' : 'white',
			coordinates: true,
			movable: { free: true, color: 'both' },
			animation: { enabled: true, duration: 200 },
			events: {
				change: () => {
					const fen = this.cgApi?.getFen();
					if (fen) this.previewFen.emit(fen);
				},
				select: (key: Key) => this.onSquareClick(key),
			},
		});
		this.refreshEnPassantOptions();
	}

	private readFields(fen: string): void {
		const fields = fen.trim().split(/\s+/);
		if (fields.length < 3) {
			return;
		}
		this.turn.set(fields[1] === 'b' ? 'b' : 'w');
		this.castling = castlingRightsFrom(fields[2]);
		this.enPassantSquare = fields[3] && fields[3] !== '-' ? fields[3] : '-';
	}

	protected cssClassesFor(code: string): string {
		return pieceCssClasses(code);
	}

	protected selectPiece(piece: string | null): void {
		this.selectedPiece.set(piece);
	}

	protected flip(): void {
		this.isFlipped = !this.isFlipped;
		this.cgApi?.set({ orientation: this.isFlipped ? 'black' : 'white' });
	}

	protected clearBoard(): void {
		this.cgApi?.set({ pieces: new Map() } as SetupConfig);
		// No kings or rooks left: castling would be impossible, so reset the rights too.
		this.castling = { ...NO_CASTLING_RIGHTS };
		this.refreshEnPassantOptions();
	}

	protected resetToStart(): void {
		this.cgApi?.set({ fen: new Chess().fen() });
		this.turn.set('w');
		this.castling = { ...FULL_CASTLING_RIGHTS };
		this.enPassantSquare = '-';
		this.refreshEnPassantOptions();
	}

	protected changeTurn(color: 'w' | 'b'): void {
		this.turn.set(color);
		this.refreshEnPassantOptions();
	}

	private onSquareClick(square: Key): void {
		if (!this.cgApi) return;

		const pieces: Pieces = new Map(this.cgApi.state.pieces);
		const selected = this.selectedPiece();

		if (selected === null) {
			pieces.delete(square);
		} else {
			const color = selected[0] === 'w' ? 'white' : 'black';
			const role = roleFromLetter(selected[1]);
			const existing = pieces.get(square);

			if (existing && existing.role === role && existing.color === color) {
				pieces.delete(square);
			} else {
				pieces.set(square, { role, color });
			}
		}

		this.cgApi.set({ pieces } as SetupConfig);
		this.refreshEnPassantOptions();
	}

	private refreshEnPassantOptions(): void {
		const pieces = this.cgApi?.state.pieces;
		if (!pieces) return;

		const options = enPassantCandidates(pieces, this.turn());
		this.enPassantOptions.set(options);
		if (!options.includes(this.enPassantSquare)) {
			this.enPassantSquare = '-';
		}
	}

	protected done(): void {
		if (!this.cgApi) return;

		const pieces = this.cgApi.state.pieces;
		if (findStructuralPositionError(pieces)) {
			this.flashError();
			return;
		}

		const placement = this.cgApi.getFen();
		const fullFen = `${placement} ${this.turn()} ${castlingField(this.castling, pieces)} ${this.enPassantSquare} 0 1`;

		if (!isLoadableFen(fullFen) || isSideNotToMoveInCheck(fullFen)) {
			this.flashError();
			return;
		}

		this.confirmed.emit(fullFen);
	}

	private flashError(): void {
		this.error.set(true);
		setTimeout(() => this.error.set(false), ERROR_FLASH_MS);
	}
}
