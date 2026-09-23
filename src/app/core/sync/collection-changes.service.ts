import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export type CollectionChange =
	{ readonly side: 'cloud'; readonly cloudId: number } | { readonly side: 'local'; readonly localId: string };

/** Lets the mirror hear every edit without each editing screen remembering to tell it. */
@Injectable({ providedIn: 'root' })
export class CollectionChangesService {
	private readonly subject = new Subject<CollectionChange>();

	readonly changes: Observable<CollectionChange> = this.subject.asObservable();

	cloud(cloudId: number | null | undefined): void {
		if (typeof cloudId === 'number' && cloudId > 0) {
			this.subject.next({ side: 'cloud', cloudId });
		}
	}

	local(localId: string | null | undefined): void {
		if (typeof localId === 'string' && localId.length > 0) {
			// An entry id is the file's id, a '#', and the entry's place in the file.
			this.subject.next({ side: 'local', localId: localId.split('#')[0] });
		}
	}
}
