import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { TabsStore } from '../tabs/tabs.store';

// A shape rather than the pages themselves, so the guard pulls no page into the initial bundle.
export interface ConfirmsUnsavedChanges {
	/** Resolves true to leave (after saving or discarding), false to stay. */
	confirmDiscardOrSave(): Promise<boolean>;
}

export const unsavedChangesGuard: CanDeactivateFn<ConfirmsUnsavedChanges> = (component) => {
	// A tab switch keeps the page alive detached, so there is nothing to discard here.
	if (inject(TabsStore).keepingCurrentPage) {
		return true;
	}
	return component.confirmDiscardOrSave();
};
