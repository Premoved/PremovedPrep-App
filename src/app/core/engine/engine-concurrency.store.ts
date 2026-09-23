import { Injectable, signal } from '@angular/core';

const KEY = 'premovedprep.engine.concurrent';

/** Off by default: a background board's engine pauses instead of running alongside the active one. */
@Injectable({ providedIn: 'root' })
export class EngineConcurrencyStore {
	private readonly _enabled = signal(read());

	readonly enabled = this._enabled.asReadonly();

	set(on: boolean): void {
		this._enabled.set(on);
		try {
			localStorage.setItem(KEY, on ? '1' : '0');
		} catch {
			// Private mode, or storage full: the choice holds for this session only.
		}
	}
}

function read(): boolean {
	try {
		return localStorage.getItem(KEY) === '1';
	} catch {
		return false;
	}
}
