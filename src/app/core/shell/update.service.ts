import { Injectable, inject } from '@angular/core';
import { DesktopAppApiService } from '../services/desktop-app.service';
import { NotificationService } from '../services/notification.service';
import { AppRelease } from '../models/user.model';

const RECHECK_MS = 6 * 60 * 60_000;

@Injectable({ providedIn: 'root' })
export class UpdateService {
	private readonly api = inject(DesktopAppApiService);
	private readonly notify = inject(NotificationService);

	private readonly current: string | null = window.premovedDesktop?.version ?? null;

	start(): void {
		if (this.current === null) {
			return;
		}
		this.check();
		window.addEventListener('online', () => this.check());
		setInterval(() => this.check(), RECHECK_MS);
	}

	private check(): void {
		this.api.release().subscribe({
			next: (release) => this.announce(release),
			error: () => {
				// Offline, or the server is older than this endpoint: nothing to announce.
			},
		});
	}

	private announce(release: AppRelease): void {
		const current = this.current;
		if (current === null) {
			return;
		}
		const href = trustedDownload(release.downloadUrl);
		if (href === null) {
			return;
		}
		const action = { label: 'Download', href };

		if (release.minimum && compareVersions(current, release.minimum) < 0) {
			this.notify.sticky(
				'update',
				'error',
				`This version (${current}) is no longer supported. Please install the latest version${release.latest ? ` (${release.latest})` : ''}.`,
				action,
				true,
			);
			return;
		}
		if (release.latest && compareVersions(current, release.latest) < 0) {
			this.notify.sticky('update', 'info', `A new version is available: ${release.latest}.`, action);
		}
	}
}

// Hosts the "Download" link may lead to. Anything else from the server is ignored, not opened.
const DOWNLOAD_HOSTS = new Set(['premovedprep.com', 'www.premovedprep.com', 'github.com']);

function trustedDownload(url: string | null | undefined): string | null {
	try {
		const parsed = new URL(url ?? '');
		return parsed.protocol === 'https:' && DOWNLOAD_HOSTS.has(parsed.hostname) ? parsed.toString() : null;
	} catch {
		return null;
	}
}

// Anything unparsable compares as equal, so a typo on the server never tells anybody to update.
export function compareVersions(a: string, b: string): number {
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) {
		return 0;
	}
	for (let index = 0; index < 3; index++) {
		if (left.core[index] !== right.core[index]) {
			return left.core[index] < right.core[index] ? -1 : 1;
		}
	}
	if (left.pre === right.pre) {
		return 0;
	}
	if (left.pre === null) {
		return 1;
	}
	if (right.pre === null) {
		return -1;
	}
	return comparePre(left.pre, right.pre);
}

function parse(value: string): { core: number[]; pre: string | null } | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
	if (!match) {
		return null;
	}
	return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

function comparePre(a: string, b: string): number {
	const left = a.split('.');
	const right = b.split('.');
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const x = left[index];
		const y = right[index];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xNumeric = /^\d+$/.test(x);
		const yNumeric = /^\d+$/.test(y);
		if (xNumeric && yNumeric) {
			if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
		} else if (xNumeric !== yNumeric) {
			return xNumeric ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}
