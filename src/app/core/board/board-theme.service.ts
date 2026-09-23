import { Injectable, signal } from '@angular/core';
import { BOARD_THEMES, BoardTheme, findBoardTheme } from './board-themes';
import { BUNDLED_PIECE_SET, DEFAULT_PIECE_SET, PIECE_ASSET_ROOT, pieceSetCss, pieceSetFor } from './piece-sets';

@Injectable({ providedIn: 'root' })
export class BoardThemeService {
	private element: HTMLStyleElement | null = null;

	private readonly installed = signal<readonly string[]>([DEFAULT_PIECE_SET]);
	readonly installedPieceSets = this.installed.asReadonly();

	readonly themes: readonly BoardTheme[] = BOARD_THEMES;

	apply(boardThemeId: string, pieceSetId: string): void {
		const theme = findBoardTheme(boardThemeId);

		document.body.style.setProperty('--board-light', theme.light);
		document.body.style.setProperty('--board-dark', theme.dark);

		const set = pieceSetFor(this.resolvePieceSet(pieceSetId));
		this.styleElement().textContent = pieceSetCss(set, this.baseUrl());
	}

	// Reads public/piece/manifest.json, written by `npm run assets` from what is actually on disk.
	async loadInstalledPieceSets(): Promise<void> {
		try {
			const response = await fetch(`${this.baseUrl()}${PIECE_ASSET_ROOT}/manifest.json`, { cache: 'no-cache' });
			if (!response.ok) {
				this.warnNoManifest(`HTTP ${response.status}`);
				return;
			}

			const body: unknown = await response.json();
			const sets = (body as { sets?: unknown })?.sets;
			if (!Array.isArray(sets)) {
				this.warnNoManifest('no `sets` array');
				return;
			}

			const named = sets.filter((id): id is string => typeof id === 'string' && id.length > 0);
			this.installed.set([...new Set([DEFAULT_PIECE_SET, ...named])]);
		} catch (error) {
			this.warnNoManifest(error instanceof Error ? error.message : String(error));
		}
	}

	private resolvePieceSet(id: string): string {
		if (this.installed().includes(id)) {
			return id;
		}
		if (id !== BUNDLED_PIECE_SET.id) {
			console.warn(`Piece set "${id}" is not installed; using ${BUNDLED_PIECE_SET.id}.`);
		}
		return BUNDLED_PIECE_SET.id;
	}

	private warnNoManifest(reason: string): void {
		console.warn(
			`No piece manifest (${reason}). Only ${BUNDLED_PIECE_SET.id} is offered - run \`npm run assets\` to install the rest.`,
		);
	}

	private baseUrl(): string {
		const base = document.baseURI;
		return base.endsWith('/') ? base : `${base}/`;
	}

	private styleElement(): HTMLStyleElement {
		if (!this.element) {
			this.element = document.createElement('style');
			this.element.setAttribute('data-piece-set', '');
			document.head.appendChild(this.element);
		}
		return this.element;
	}
}
