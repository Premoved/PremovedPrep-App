'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');

const server = require('./local-server');
const { Settings } = require('./local/settings');
const { LocalStore } = require('./local/store');
const { Engines } = require('./local/engine');
const { Databases } = require('./local/database');
const { Bridge } = require('./local/bridge');

const WEB_ROOT = path.join(__dirname, '..', 'dist', 'premoved-prep-app', 'browser');

// A file inside app.asar is not a path Windows can load an icon from; asarUnpack keeps a real copy.
const ICON = path.join(__dirname, '..', 'build', 'icon.ico').replace('app.asar', 'app.asar.unpacked');

const TITLE_BAR_HEIGHT = 40;

const INITIAL_OVERLAY = { color: '#2e2e2e', symbolColor: '#d5d2d1', height: TITLE_BAR_HEIGHT };

const WINDOW_BACKGROUND = '#2e2e2e';

const PORT_BUSY_TITLE = 'PremovedPrep';
const PORT_BUSY_MESSAGE =
	`PremovedPrep serves itself on 127.0.0.1:${server.PORT}, and that port is already in use.\n\n` +
	'Close whatever is listening on it and start PremovedPrep again.';

const UNSAVED_TITLE = 'PremovedPrep';
const UNSAVED_MESSAGE = 'You have unsaved changes. Confirm quit?';

const ANSWER_TIMEOUT_MS = 1500;

let mainWindow = null;
let closing = false;
let running = null;
let engines = null;
let databases = null;

app.setAppUserModelId('com.premoved.premovedprep');

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) {
				mainWindow.restore();
			}
			mainWindow.focus();
		}
	});

	app.whenReady().then(main);
}

async function main() {
	try {
		running = await server.start({ webRoot: WEB_ROOT });
	} catch (error) {
		const busy = error && error.code === 'EADDRINUSE';
		dialog.showErrorBox(PORT_BUSY_TITLE, busy ? PORT_BUSY_MESSAGE : String(error && error.stack ? error.stack : error));
		app.quit();
		return;
	}

	ipcMain.handle('premoved:title-bar-colors', (event, color, symbolColor) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window || typeof color !== 'string' || typeof symbolColor !== 'string') {
			return false;
		}
		if (!/^#[0-9a-fA-F]{3,8}$/.test(color.trim()) || !/^#[0-9a-fA-F]{3,8}$/.test(symbolColor.trim())) {
			return false;
		}
		window.setTitleBarOverlay({ color: color.trim(), symbolColor: symbolColor.trim(), height: TITLE_BAR_HEIGHT });
		return true;
	});

	// Electron grants camera/mic/notifications/etc by default; the app needs none of them.
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	session.defaultSession.setPermissionCheckHandler(() => false);

	startLocalResources();

	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
}

function startLocalResources() {
	const settings = new Settings(app.getPath('userData'));
	settings.update({ version: app.getVersion() });

	const store = new LocalStore(settings);
	store.ensure();

	const push = (event, data) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('premoved:bridge:event', { event, data });
		}
	};

	engines = new Engines(settings, push);
	engines.adoptBundled(bundledEngine(), null);

	databases = new Databases(settings, app.getPath('userData'), push);
	void databases.repair();

	const bridge = new Bridge({ settings, store, engines, databases, window: () => mainWindow });

	ipcMain.handle('premoved:bridge', async (event, method, params) => {
		// Only the main window's own page may call the bridge.
		if (!mainWindow || event.sender !== mainWindow.webContents) {
			return { ok: false, code: 'UNAUTHORIZED', message: 'Not this window' };
		}
		try {
			return { ok: true, value: await bridge.handle(String(method), params ?? {}) };
		} catch (error) {
			return {
				ok: false,
				code: error && error.code ? error.code : 'FAILED',
				message: error && error.message ? error.message : String(error),
			};
		}
	});
}

function bundledEngine() {
	const name = process.platform === 'win32' ? 'stockfish.exe' : 'stockfish';
	const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
	const forThisMachine = path.join(base, 'engines', `${process.platform}-${process.arch}`, name);
	return fs.existsSync(forThisMachine) ? forThisMachine : path.join(base, 'engines', name);
}

function createWindow() {
	Menu.setApplicationMenu(null);

	mainWindow = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1024,
		minHeight: 640,
		backgroundColor: WINDOW_BACKGROUND,
		show: false,
		titleBarStyle: 'hidden',
		titleBarOverlay: INITIAL_OVERLAY,
		icon: ICON,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			additionalArguments: [`--premoved-version=${app.getVersion()}`],
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false,
		},
	});

	mainWindow.once('ready-to-show', () => mainWindow.show());

	keepNavigationInside(mainWindow);
	bindShortcuts(mainWindow);
	guardClose(mainWindow);

	mainWindow.on('closed', () => {
		mainWindow = null;
	});

	void mainWindow.loadURL(running.url);
}

function guardClose(window) {
	window.on('close', (event) => {
		if (closing) {
			return;
		}
		event.preventDefault();
		void mayClose(window).then((allowed) => {
			if (!allowed || window.isDestroyed()) {
				return;
			}
			closing = true;
			window.close();
		});
	});
}

async function mayClose(window) {
	const unkept = await ask(window, 'unsaved').catch(() => 0);
	if (!unkept) {
		return true;
	}

	const answer = await dialog.showMessageBox(window, {
		type: 'warning',
		title: UNSAVED_TITLE,
		message: UNSAVED_MESSAGE,
		buttons: ['Quit', 'Cancel'],
		defaultId: 1,
		cancelId: 1,
		noLink: true,
	});
	return answer.response === 0;
}

function ask(window, question) {
	return new Promise((resolve, reject) => {
		const id = `${question}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

		const done = (finish, value) => {
			clearTimeout(timer);
			ipcMain.removeListener('premoved:answer', onAnswer);
			finish(value);
		};
		const onAnswer = (event, answerId, value) => {
			// Matched by id and sender, so only this window's page can answer its own question.
			if (answerId !== id || event.sender !== window.webContents) {
				return;
			}
			done(resolve, value);
		};
		const timer = setTimeout(() => done(reject, new Error('No answer')), ANSWER_TIMEOUT_MS);

		ipcMain.on('premoved:answer', onAnswer);
		window.webContents.send('premoved:ask', { id, question });
	});
}

// The only schemes handed to the system: a web address, and mailto, which the contact links and
// the board's share button use. Anything else is dropped rather than passed to a protocol handler.
const HANDS_OVER = /^(https?:\/\/|mailto:)/i;

function keepNavigationInside(window) {
	const inside = (url) => url.startsWith(running.url) || url === 'about:blank';

	// Popups are always denied; a link the page tried to open in a new window opens in the system browser instead.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (HANDS_OVER.test(url) && !inside(url)) {
			void shell.openExternal(url);
		}
		return { action: 'deny' };
	});

	window.webContents.on('will-navigate', (event, url) => {
		if (inside(url)) {
			return;
		}
		event.preventDefault();
		if (HANDS_OVER.test(url)) {
			void shell.openExternal(url);
		}
	});
}

function bindShortcuts(window) {
	window.webContents.on('before-input-event', (event, input) => {
		if (input.type !== 'keyDown') {
			return;
		}
		const key = (input.key || '').toLowerCase();
		const inspector = key === 'f12' || (input.control && input.shift && key === 'i');
		const reload = key === 'f5' || (input.control && key === 'r');

		if (inspector) {
			// Development only: in an installed copy the console could reach the local-resources bridge.
			if (!app.isPackaged) {
				window.webContents.toggleDevTools();
			}
			event.preventDefault();
		} else if (reload) {
			if (input.shift) {
				window.webContents.reloadIgnoringCache();
			} else {
				window.webContents.reload();
			}
			event.preventDefault();
		}
	});
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('will-quit', () => {
	if (engines) {
		engines.closeAll();
		engines = null;
	}
	if (databases) {
		databases.closeAll();
		databases = null;
	}
	if (running) {
		void running.close();
		running = null;
	}
});
