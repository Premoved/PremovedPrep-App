'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PORT = 41730;
const HOST = '127.0.0.1';

const DEFAULT_API_ORIGIN = 'https://api.premovedprep.com';

function apiOrigin() {
	// Override ignored when packaged: an env var could otherwise redirect credentials elsewhere.
	let packaged = false;
	try {
		packaged = require('electron').app.isPackaged;
	} catch {
		packaged = false;
	}
	const override = process.env.PREMOVEDPREP_API_ORIGIN;
	return !packaged && override ? override : DEFAULT_API_ORIGIN;
}

const API_ORIGIN = apiOrigin();

const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

const TYPES = new Map(
	Object.entries({
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.mjs': 'text/javascript; charset=utf-8',
		'.css': 'text/css; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.svg': 'image/svg+xml',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.webp': 'image/webp',
		'.ico': 'image/x-icon',
		'.mp3': 'audio/mpeg',
		'.ogg': 'audio/ogg',
		'.woff': 'font/woff',
		'.woff2': 'font/woff2',
		'.txt': 'text/plain; charset=utf-8',
		'.map': 'application/json; charset=utf-8',
	}),
);

const SECURITY_HEADERS = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
	'Content-Security-Policy':
		"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
		"form-action 'self'; script-src 'self'; worker-src 'self'; " +
		"style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
		"connect-src 'self'; manifest-src 'self'",
};

const NO_STORE = { 'Cache-Control': 'no-store' };

function baseHeaders(extra) {
	return Object.assign({}, SECURITY_HEADERS, NO_STORE, extra);
}

function endWith(res, status, text) {
	res.writeHead(status, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
	res.end(text);
}

// Loopback only: Host header is checked against DNS rebinding.
function hostAllowed(req) {
	const host = (req.headers.host || '').toLowerCase();
	return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

function forwardHeaders(headers, drop) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower) || drop.has(lower)) {
			continue;
		}
		out[name] = value;
	}
	return out;
}

function proxyApi(req, res, upstream) {
	const target = new URL(req.url, upstream);
	const transport = target.protocol === 'http:' ? http : https;

	const outgoing = transport.request(
		{
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port || (target.protocol === 'http:' ? 80 : 443),
			path: target.pathname + target.search,
			method: req.method,
			// Origin/Referer dropped: this is server-to-server forwarding, not a browser cross-origin request.
			headers: forwardHeaders(req.headers, new Set(['host', 'origin', 'referer'])),
		},
		(apiRes) => {
			const headers = forwardHeaders(apiRes.headers, new Set());
			for (const name of Object.keys(headers)) {
				if (name.toLowerCase().startsWith('access-control-')) {
					delete headers[name];
				}
			}
			res.writeHead(apiRes.statusCode || 502, headers);
			apiRes.pipe(res);
		},
	);

	outgoing.setTimeout(120_000, () => outgoing.destroy(new Error('upstream timeout')));

	outgoing.on('error', (error) => {
		if (res.headersSent) {
			res.destroy();
			return;
		}
		res.writeHead(502, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
		res.end(JSON.stringify({ message: String(error && error.message ? error.message : error) }));
	});

	req.pipe(outgoing);
}

// Returns null when the decoded path would resolve outside root (path traversal).
function resolveInside(root, urlPath) {
	let decoded;
	try {
		decoded = decodeURIComponent(urlPath);
	} catch {
		return null;
	}
	const resolved = path.resolve(root, '.' + path.posix.normalize(decoded));
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return null;
	}
	return resolved;
}

async function serveFile(req, res, file, status) {
	const type = TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
	const stat = await fsp.stat(file);
	res.writeHead(status, baseHeaders({ 'Content-Type': type, 'Content-Length': stat.size }));
	if (req.method === 'HEAD') {
		res.end();
		return;
	}
	fs.createReadStream(file).pipe(res);
}

async function serveStatic(req, res, root) {
	const urlPath = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
	const index = path.join(root, 'index.html');

	const candidate = resolveInside(root, urlPath);
	if (candidate === null) {
		endWith(res, 400, 'bad path');
		return;
	}

	try {
		const stat = await fsp.stat(candidate);
		if (stat.isFile()) {
			await serveFile(req, res, candidate, 200);
			return;
		}
	} catch {
		// No file at this path: falls through to the SPA index.html.
	}

	await serveFile(req, res, index, 200);
}

function start({ webRoot, apiOrigin = API_ORIGIN }) {
	const root = path.resolve(webRoot);

	const server = http.createServer((req, res) => {
		if (!hostAllowed(req)) {
			endWith(res, 403, 'forbidden');
			return;
		}

		if (req.url.startsWith('/api/') || req.url === '/api') {
			proxyApi(req, res, apiOrigin);
			return;
		}

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			endWith(res, 405, 'method not allowed');
			return;
		}

		serveStatic(req, res, root).catch((error) => {
			if (!res.headersSent) {
				endWith(res, 500, String(error && error.message ? error.message : error));
			}
		});
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(PORT, HOST, () => {
			server.removeListener('error', reject);
			resolve({
				url: `http://${HOST}:${PORT}/`,
				port: PORT,
				close: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

module.exports = { start, PORT, HOST, API_ORIGIN };
