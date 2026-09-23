import { Injectable, signal } from '@angular/core';

const MANIFEST = 'sound/manifest.json';
const ASSET_ROOT = 'sound/';

export type BoardSound = 'move' | 'capture' | 'castle';

const GAIN = 0.55;

@Injectable({ providedIn: 'root' })
export class MoveSoundService {
	private readonly installed = signal(false);
	readonly available = this.installed.asReadonly();

	private sources = new Map<BoardSound, readonly string[]>();

	private context: AudioContext | null = null;
	private gain: GainNode | null = null;
	private readonly buffers = new Map<BoardSound, AudioBuffer>();
	// In-flight decodes, so a held key does not start the same download twice.
	private readonly loading = new Map<BoardSound, Promise<AudioBuffer | null>>();

	async load(): Promise<void> {
		try {
			const response = await fetch(`${baseUrl()}${MANIFEST}`, { cache: 'no-cache' });
			if (!response.ok) return;

			// The dev server's SPA fallback answers a missing file with index.html; .json() below
			// throws on that, which the catch below treats the same as no manifest.
			const body = (await response.json()) as { sounds?: Record<string, unknown> };
			const declared = body.sounds;
			if (!declared || typeof declared !== 'object') return;

			const found = new Map<BoardSound, readonly string[]>();
			for (const key of ['move', 'capture', 'castle'] as const) {
				const paths = declared[key];
				if (!Array.isArray(paths)) continue;
				const urls = paths.filter((path): path is string => typeof path === 'string' && path.length > 0);
				if (urls.length > 0) {
					found.set(key, urls);
				}
			}

			this.sources = found;
			this.installed.set(found.size > 0);
		} catch {
			// No manifest, or not JSON: the board stays silent.
		}
	}

	play(sound: BoardSound, enabled: boolean): void {
		if (!enabled || !this.installed()) return;

		const context = this.audio();
		if (!context) return;

		const ready = this.buffers.get(sound);
		if (ready) {
			this.emit(context, ready);
			return;
		}

		void this.decode(sound);
	}

	prime(): void {
		if (!this.installed() || !this.audio()) return;
		for (const sound of this.sources.keys()) {
			void this.decode(sound);
		}
	}

	primeOnFirstGesture(enabled: () => boolean): void {
		const once = () => {
			if (enabled()) {
				this.prime();
			}
		};
		document.addEventListener('pointerdown', once, { once: true, capture: true });
		document.addEventListener('keydown', once, { once: true, capture: true });
	}

	private emit(context: AudioContext, buffer: AudioBuffer): void {
		if (context.state === 'suspended') {
			void context.resume();
		}

		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(this.gain ?? context.destination);
		source.start();
	}

	private audio(): AudioContext | null {
		if (this.context) return this.context;

		try {
			const context = new AudioContext();
			const gain = context.createGain();
			gain.gain.value = GAIN;
			gain.connect(context.destination);

			this.context = context;
			this.gain = gain;
			return context;
		} catch {
			return null;
		}
	}

	private decode(sound: BoardSound): Promise<AudioBuffer | null> {
		const running = this.loading.get(sound);
		if (running) return running;

		const attempt = (async (): Promise<AudioBuffer | null> => {
			const context = this.audio();
			const urls = this.sources.get(sound);
			if (!context || !urls) return null;

			for (const url of urls) {
				try {
					const response = await fetch(`${baseUrl()}${ASSET_ROOT}${url}`);
					if (!response.ok) continue;
					const buffer = await context.decodeAudioData(await response.arrayBuffer());
					this.buffers.set(sound, buffer);
					return buffer;
				} catch {
					// This source did not decode: try the next one.
				}
			}

			this.sources.delete(sound);
			this.installed.set(this.sources.size > 0);
			return null;
		})().finally(() => this.loading.delete(sound));

		this.loading.set(sound, attempt);
		return attempt;
	}
}

function baseUrl(): string {
	const base = document.baseURI;
	return base.endsWith('/') ? base : `${base}/`;
}
