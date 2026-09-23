// IndexedDB holds the non-extractable CryptoKey: scripts can use it, never read its bytes.
const DATABASE = 'premovedprep-vault';
const STORE = 'keys';
const RECORD = 'master';

export interface StoredKey {
	readonly userId: number;
	readonly keyId: string;
	readonly key: CryptoKey;
}

export async function rememberKey(stored: StoredKey): Promise<void> {
	await withStore('readwrite', (store) => store.put(stored, RECORD));
}

export async function recallKey(userId: number, keyId: string): Promise<CryptoKey | null> {
	const stored = await withStore<StoredKey | undefined>('readonly', (store) => store.get(RECORD));

	// A mismatch belongs to an ended session or a since-replaced key, so it is deleted, not returned.
	if (!stored || stored.userId !== userId || stored.keyId !== keyId) {
		if (stored) {
			await forgetKey();
		}
		return null;
	}
	return stored.key;
}

export async function forgetKey(): Promise<void> {
	await withStore('readwrite', (store) => store.delete(RECORD));
}

// Every failure here answers undefined rather than throwing: this store is a convenience, and when
// it is unavailable the application falls back to asking for the password again.
function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		let database: IDBDatabase | null = null;

		let opening: IDBOpenDBRequest;
		try {
			opening = indexedDB.open(DATABASE, 1);
		} catch {
			resolve(undefined);
			return;
		}

		opening.onupgradeneeded = () => {
			opening.result.createObjectStore(STORE);
		};
		opening.onerror = () => resolve(undefined);
		opening.onblocked = () => resolve(undefined);

		opening.onsuccess = () => {
			database = opening.result;
			try {
				const transaction = database.transaction(STORE, mode);
				const request = run(transaction.objectStore(STORE));

				request.onsuccess = () => resolve(request.result as T);
				request.onerror = () => resolve(undefined);
				transaction.oncomplete = () => database?.close();
				transaction.onabort = () => {
					database?.close();
					resolve(undefined);
				};
			} catch {
				database.close();
				resolve(undefined);
			}
		};
	});
}
