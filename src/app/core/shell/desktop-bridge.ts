export interface BridgeResult {
	readonly ok: boolean;
	readonly value?: unknown;
	readonly code?: string;
	readonly message?: string;
}

export interface LocalBridge {
	request(method: string, params: Record<string, unknown>): Promise<BridgeResult>;
	// Subscribes to a pushed event; the returned function unsubscribes.
	on(event: string, handler: (data: unknown) => void): () => void;
}

export interface DesktopApi {
	readonly version: string | null;
	readonly platform: string;
	readonly arch: string;
	readonly titleBarHeight: number;
	setTitleBarColors(color: string, symbolColor: string): Promise<boolean>;
	// Answers one of the shell's questions, the opposite direction from `bridge`. Returned fn forgets the answer.
	onAsk(question: string, answer: () => unknown): () => void;
	readonly bridge: LocalBridge;
}

declare global {
	interface Window {
		premovedDesktop?: DesktopApi;
	}
}
