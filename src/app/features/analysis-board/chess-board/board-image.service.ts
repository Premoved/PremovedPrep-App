import { Injectable } from '@angular/core';

export interface DiagramOptions {
	boardElement: HTMLElement;
	blackOriented: boolean;
	withCoordinates: boolean;
}

const LIGHT_SQUARE = '#ebecd0';
const DARK_SQUARE = '#b5b993';
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const PIXEL_RATIO = 2;
const JPEG_QUALITY = 0.95;

@Injectable({ providedIn: 'root' })
export class BoardImageService {
	async downloadDiagram(options: DiagramOptions, fileName = 'chess-diagram.jpg'): Promise<void> {
		const dataUrl = await this.render(options);
		if (!dataUrl) return;

		const link = document.createElement('a');
		link.download = fileName;
		link.href = dataUrl;
		link.click();
	}

	private async render({ boardElement, blackOriented, withCoordinates }: DiagramOptions): Promise<string | null> {
		const size = boardElement.clientWidth;
		if (size <= 0) return null;

		const canvas = document.createElement('canvas');
		canvas.width = size * PIXEL_RATIO;
		canvas.height = size * PIXEL_RATIO;

		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.scale(PIXEL_RATIO, PIXEL_RATIO);

		const squareSize = size / 8;
		this.paintSquares(ctx, squareSize);
		if (withCoordinates) {
			this.paintCoordinates(ctx, squareSize, size, blackOriented);
		}
		await this.paintPieces(ctx, boardElement, squareSize);

		// 'image/jpg' is not a registered MIME type; browsers fall back to PNG.
		return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
	}

	private paintSquares(ctx: CanvasRenderingContext2D, squareSize: number): void {
		const { light, dark } = this.squareColours();

		for (let row = 0; row < 8; row++) {
			for (let col = 0; col < 8; col++) {
				ctx.fillStyle = (row + col) % 2 === 1 ? dark : light;
				ctx.fillRect(col * squareSize, row * squareSize, squareSize, squareSize);
			}
		}
	}

	private squareColours(): { light: string; dark: string } {
		// BoardThemeService defines --board-light/--board-dark on <body>, not <html>.
		const style = getComputedStyle(document.body);
		const light = style.getPropertyValue('--board-light').trim();
		const dark = style.getPropertyValue('--board-dark').trim();
		return { light: light || LIGHT_SQUARE, dark: dark || DARK_SQUARE };
	}

	private paintCoordinates(
		ctx: CanvasRenderingContext2D,
		squareSize: number,
		size: number,
		blackOriented: boolean,
	): void {
		ctx.fillStyle = '#000';
		ctx.font = 'bold 10px sans-serif';

		for (let i = 0; i < 8; i++) {
			ctx.fillText(blackOriented ? FILES[7 - i] : FILES[i], i * squareSize + 2, size - 2);
			ctx.fillText(blackOriented ? RANKS[i] : RANKS[7 - i], 2, i * squareSize + 12);
		}
	}

	private paintPieces(ctx: CanvasRenderingContext2D, boardElement: HTMLElement, squareSize: number): Promise<void[]> {
		const pieces = Array.from(boardElement.querySelectorAll('piece'));

		return Promise.all(
			pieces.map(
				(piece) =>
					new Promise<void>((resolve) => {
						const style = getComputedStyle(piece);
						const backgroundImage = style.backgroundImage;
						if (!backgroundImage || backgroundImage === 'none') {
							resolve();
							return;
						}

						const matrix = style.transform.match(/matrix\((.+)\)/);
						if (!matrix) {
							resolve();
							return;
						}
						const values = matrix[1].split(', ');

						const image = new Image();
						image.onload = () => {
							ctx.drawImage(image, parseFloat(values[4]), parseFloat(values[5]), squareSize, squareSize);
							resolve();
						};
						image.onerror = () => resolve();
						image.src = backgroundImage.slice(4, -1).replace(/"/g, '');
					}),
			),
		);
	}
}
