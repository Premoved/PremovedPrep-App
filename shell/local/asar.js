'use strict';

const path = require('node:path');

// Electron can't start a worker_threads Worker from a script inside app.asar; electron-builder
// unpacks shell/local next to it as app.asar.unpacked (see asarUnpack in electron-builder.yml).
// No-op in development, where the path never contains app.asar.
function unpacked(scriptPath) {
	const marker = `${path.sep}app.asar${path.sep}`;
	return scriptPath.includes(marker)
		? scriptPath.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`)
		: scriptPath;
}

module.exports = { unpacked };
