import { LocalShelfService } from '../../core/agent/local-shelf.service';
import { ClipboardContents } from '../../core/services/clipboard.store';
import { NotificationService } from '../../core/services/notification.service';

// Drops whole tag lines by name; the rest of the PGN is left exactly as it was.
export function withoutTags(pgn: string, names: readonly string[]): string {
	const pattern = new RegExp(`^\\s*\\[\\s*(?:${names.join('|')})\\s+"(?:[^"\\\\]|\\\\.)*"\\s*\\]\\s*$`);
	return pgn
		.split(/\r?\n/)
		.filter((line) => !pattern.test(line))
		.join('\n');
}

/**
 * After a cut is pasted elsewhere: the originals out of their file, in one rewrite, and only those
 * still as they were copied. Shared by the local and the cloud paste.
 */
export async function removeCutEntries(
	shelf: LocalShelfService,
	notify: NotificationService,
	from: NonNullable<ClipboardContents['from']>,
): Promise<void> {
	const total = from.entryIds.length;
	let left: number;
	try {
		left = (await shelf.removeEntries(from.entryIds, from.pgns)).skipped;
	} catch {
		left = total;
	}
	if (left > 0) {
		notify.error(
			`${left} of ${total} ${left === 1 ? 'entry' : 'entries'} pasted here could not be removed from the original ` +
				`collection, and now exist in both.`,
		);
	}
}
