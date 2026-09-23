export interface EngineTransport {
	send(command: string): void;
	dispose(): void;
}

export type UciLineHandler = (line: string) => void;

export function createLocalEngine(
	bridge: LocalEngineBridge,
	engineId: number,
	onLine: UciLineHandler,
	onError: (message: string) => void,
): EngineTransport {
	let sessionId: string | null = null;
	let disposed = false;

	const queued: string[] = [];

	const detachLine = bridge.on('engine.line', (data) => {
		const frame = data as { sessionId: string; line: string };
		if (frame.sessionId === sessionId) {
			onLine(frame.line);
		}
	});

	const detachClosed = bridge.on('engine.closed', (data) => {
		const frame = data as { sessionId: string };
		if (frame.sessionId === sessionId && !disposed) {
			onError('The engine stopped.');
		}
	});

	bridge
		.request<{ sessionId: string }>('engine.open', { engineId })
		.then((handle) => {
			if (disposed) {
				void bridge.request('engine.close', { sessionId: handle.sessionId });
				return;
			}
			sessionId = handle.sessionId;
			for (const command of queued.splice(0)) {
				void bridge.request('engine.send', { sessionId, command });
			}
		})
		.catch((error: Error) => onError(error.message));

	return {
		send: (command) => {
			if (disposed) return;
			if (sessionId === null) {
				queued.push(command);
				return;
			}
			void bridge.request('engine.send', { sessionId, command }).catch(() => undefined);
		},
		dispose: () => {
			disposed = true;
			detachLine();
			detachClosed();
			if (sessionId !== null) {
				void bridge.request('engine.close', { sessionId }).catch(() => undefined);
				sessionId = null;
			}
		},
	};
}

export interface LocalEngineBridge {
	request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
	on(event: string, handler: (data: unknown) => void): () => void;
}
