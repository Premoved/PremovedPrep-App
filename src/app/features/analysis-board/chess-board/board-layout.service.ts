import { ChangeDetectorRef, Injectable, OnDestroy, inject, signal } from '@angular/core';
import { ViewportService } from '../../../core/layout/viewport.service';
import { FrameResizeObserver } from '../../../core/browser/frame-resize-observer';

export interface BoardLayoutElements {
	shell: HTMLElement;
	row: HTMLElement;
	column: HTMLElement;
	square: HTMLElement;
	controls: HTMLElement;
}

export type SetupContentProbe = () => number | null;

const NARROW_HYSTERESIS_PX = 24;
// One more than the deepest measure-write chain: width -> square size -> column height.
const PRIMING_PASSES = 3;
const SETUP_BOTTOM_MARGIN = 8;
const MAX_BOARD_WIDTH = 640;
const MIN_USABLE_BOARD_WIDTH = 260;
// Lower on phones so a landscape screen still fits the board and its controls.
const MIN_MOBILE_BOARD_WIDTH = 160;

const RESERVED_ICONS_HEIGHT = 92;
const ROW_GAP = 16;

// Header and page toolbar kept in view above the board on phones; 132px at the default text size.
const MOBILE_CHROME_REM = 8.25;

@Injectable()
export class BoardLayoutService implements OnDestroy {
	private readonly cdr = inject(ChangeDetectorRef);
	private readonly viewport = inject(ViewportService);

	readonly isNarrow = signal(false);

	private reserveUtilities = true;
	readonly squareSize = signal(0);
	readonly floorWidth = signal(260);
	readonly ceilingWidth = signal(MAX_BOARD_WIDTH);
	readonly actionsBarHeight = signal<number | null>(null);
	readonly setupStickToBoardTop = signal(false);
	readonly setupBottomOffset = signal<number | null>(null);

	readonly preferredPaneWidth = signal<number | null>(null);

	private elements?: BoardLayoutElements;
	private paneEl?: HTMLElement;
	private probeSetupContent: SetupContentProbe = () => null;
	private resizeObserver?: FrameResizeObserver;
	private transitionEndListener?: () => void;
	private narrowSwitchShellWidth: number | null = null;

	attach(elements: BoardLayoutElements, probeSetupContent: SetupContentProbe, reserveUtilities = true): void {
		this.elements = elements;
		this.probeSetupContent = probeSetupContent;
		this.reserveUtilities = reserveUtilities;

		this.resizeObserver = new FrameResizeObserver(() => this.recompute());
		// Observes only elements whose size changes externally, never one this loop writes.
		this.resizeObserver.observe(elements.shell);
		this.paneEl = elements.shell.parentElement?.parentElement ?? undefined;
		if (this.paneEl) {
			this.resizeObserver.observe(this.paneEl);
		}

		this.transitionEndListener = () => this.recompute();
		window.addEventListener('transitionend', this.transitionEndListener);

		for (let pass = 0; pass < PRIMING_PASSES; pass++) {
			if (!this.recompute()) return;
		}
	}

	ngOnDestroy(): void {
		this.resizeObserver?.disconnect();
		if (this.transitionEndListener) {
			window.removeEventListener('transitionend', this.transitionEndListener);
		}
	}

	recompute(setupContentHeight?: number): boolean {
		const el = this.elements;
		if (!el) return false;

		// Off-screen (e.g. inactive tab) measures as zero; bail rather than write a zero layout.
		if (!el.shell.isConnected || el.shell.clientWidth === 0) return false;

		let changed = false;

		// Read from the stylesheet, which sizes these in rem: they grow with the browser's text size.
		const shellStyle = getComputedStyle(el.shell);
		const shellPaddingY = px(shellStyle.paddingTop) + px(shellStyle.paddingBottom);
		const shellPaddingX = px(shellStyle.paddingLeft) + px(shellStyle.paddingRight);
		const columnGap = px(getComputedStyle(el.column).rowGap);

		const shellContentHeight = el.shell.clientHeight - shellPaddingY;
		const controlsHeight = el.controls.getBoundingClientRect().height;
		const widthCap = el.shell.clientWidth - shellPaddingX;

		if (this.viewport.isMobile()) {
			// A fixed allowance, not the board's own offset: on the search pages it sits far down the page.
			const chrome = MOBILE_CHROME_REM * px(getComputedStyle(document.documentElement).fontSize);
			const viewportCap = window.innerHeight - chrome - controlsHeight - columnGap;
			const width = this.clampWidth(viewportCap, widthCap, MIN_MOBILE_BOARD_WIDTH);
			changed = this.writeIfChanged(this.ceilingWidth, width) || changed;
			changed = this.writeIfChanged(this.floorWidth, width) || changed;
		} else {
			const ceilingCap = shellContentHeight - controlsHeight - columnGap;
			changed = this.writeIfChanged(this.ceilingWidth, this.clampWidth(ceilingCap, widthCap)) || changed;

			const heightCap = this.reserveUtilities
				? shellContentHeight - controlsHeight - columnGap - ROW_GAP - RESERVED_ICONS_HEIGHT
				: ceilingCap;
			changed = this.writeIfChanged(this.floorWidth, this.clampWidth(heightCap, widthCap)) || changed;
		}

		changed = this.updateNarrowMode(el) || changed;

		if (!this.isNarrow()) {
			const columnHeight = el.column.getBoundingClientRect().height;
			if (columnHeight > 0 && columnHeight !== this.actionsBarHeight()) {
				this.actionsBarHeight.set(columnHeight);
				changed = true;
			}
		}

		const newSquareSize = el.square.getBoundingClientRect().height / 8;
		if (newSquareSize > 0) {
			changed = this.writeIfChanged(this.squareSize, newSquareSize) || changed;
		}

		changed = this.updatePreferredPaneWidth(el) || changed;
		changed = this.updateSetupAnchors(el.square, setupContentHeight) || changed;

		if (changed) {
			// Synchronous: this is a measure-write-measure loop, not a normal CD-triggered update.
			this.cdr.detectChanges();
		}

		return changed;
	}

	private clampWidth(heightCap: number, widthCap: number, floor = MIN_USABLE_BOARD_WIDTH): number {
		return Math.max(floor, Math.min(heightCap, widthCap, MAX_BOARD_WIDTH));
	}

	private writeIfChanged(target: { (): number; set(value: number): void }, value: number): boolean {
		if (Math.abs(value - target()) <= 0.5) return false;
		target.set(value);
		return true;
	}

	private updateNarrowMode(el: BoardLayoutElements): boolean {
		if (this.viewport.isMobile() && this.reserveUtilities) {
			if (this.isNarrow()) return false;
			this.isNarrow.set(true);
			this.narrowSwitchShellWidth = null;
			return true;
		}

		if (this.isNarrow() && this.narrowSwitchShellWidth === null) {
			this.isNarrow.set(false);
			return true;
		}

		if (!this.reserveUtilities) {
			if (!this.isNarrow()) {
				return false;
			}
			this.isNarrow.set(false);
			this.narrowSwitchShellWidth = null;
			return true;
		}

		if (!this.isNarrow()) {
			if (el.row.scrollWidth > el.row.clientWidth + 1) {
				this.isNarrow.set(true);
				this.narrowSwitchShellWidth = el.shell.getBoundingClientRect().width;
				return true;
			}
			return false;
		}

		// Requires growing back past the switch width by the hysteresis margin, not just past it.
		const shellWidth = el.shell.getBoundingClientRect().width;
		if (this.narrowSwitchShellWidth !== null && shellWidth > this.narrowSwitchShellWidth + NARROW_HYSTERESIS_PX) {
			this.isNarrow.set(false);
			this.narrowSwitchShellWidth = null;
			return true;
		}
		return false;
	}

	private updatePreferredPaneWidth(el: BoardLayoutElements): boolean {
		const previous = this.preferredPaneWidth();
		let next: number | null = null;

		if (this.paneEl && !this.isNarrow()) {
			const slack = (el.column.getBoundingClientRect().left - el.row.getBoundingClientRect().left) * 2;
			if (slack > 1) {
				next = this.paneEl.getBoundingClientRect().width - slack;
			}
		}

		if (previous === null && next === null) return false;
		if (previous !== null && next !== null && Math.abs(previous - next) <= 0.5) return false;
		this.preferredPaneWidth.set(next);
		return true;
	}

	private updateSetupAnchors(squareEl: HTMLElement, override?: number): boolean {
		const contentHeight = override ?? this.probeSetupContent();
		if (contentHeight === null || contentHeight === undefined) return false;

		const rect = squareEl.getBoundingClientRect();
		const anchorBottomY = window.innerHeight - SETUP_BOTTOM_MARGIN;
		let changed = false;

		const newStick = contentHeight < anchorBottomY - rect.top;
		if (newStick !== this.setupStickToBoardTop()) {
			this.setupStickToBoardTop.set(newStick);
			changed = true;
		}

		const newOffset = rect.bottom - anchorBottomY;
		const current = this.setupBottomOffset();
		if (current === null || Math.abs(newOffset - current) > 0.5) {
			this.setupBottomOffset.set(newOffset);
			changed = true;
		}

		return changed;
	}
}

function px(value: string): number {
	return parseFloat(value) || 0;
}
