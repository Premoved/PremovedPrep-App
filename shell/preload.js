'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const VERSION_FLAG = '--premoved-version=';

function version() {
	const arg = process.argv.find((value) => value.startsWith(VERSION_FLAG));
	return arg ? arg.slice(VERSION_FLAG.length) : null;
}

// Handlers are held here, not exposed via raw ipcRenderer, so the page can't listen to other channels.
const listeners = new Map();

ipcRenderer.on('premoved:bridge:event', (_event, frame) => {
	const handlers = listeners.get(frame?.event);
	if (!handlers) {
		return;
	}
	for (const handler of [...handlers]) {
		handler(frame.data);
	}
});

const answerers = new Map();

ipcRenderer.on('premoved:ask', (_event, frame) => {
	const reply = (value) => ipcRenderer.send('premoved:answer', frame?.id, value);
	const answer = answerers.get(frame?.question);
	if (!answer) {
		reply(null);
		return;
	}
	try {
		Promise.resolve(answer()).then(reply, () => reply(null));
	} catch {
		reply(null);
	}
});

contextBridge.exposeInMainWorld('premovedDesktop', {
	version: version(),
	platform: process.platform,
	arch: process.arch,
	titleBarHeight: 40,
	setTitleBarColors: (color, symbolColor) =>
		ipcRenderer.invoke('premoved:title-bar-colors', color, symbolColor),

	onAsk: (question, answer) => {
		answerers.set(question, answer);
		return () => answerers.delete(question);
	},

	bridge: {
		request: (method, params) => ipcRenderer.invoke('premoved:bridge', method, params),
		on: (event, handler) => {
			const handlers = listeners.get(event) ?? new Set();
			handlers.add(handler);
			listeners.set(event, handlers);
			return () => handlers.delete(handler);
		},
	},
});
