import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import type { AnalysisBoardComponent } from '../../features/analysis-board/analysis-board.component';
import { TabsStore } from '../tabs/tabs.store';

export const unsavedChangesGuard: CanDeactivateFn<AnalysisBoardComponent> = (component) => {
	// A tab switch keeps the board's page alive detached, so there is nothing to discard here.
	if (inject(TabsStore).keepingCurrentPage) {
		return true;
	}
	return component.confirmDiscardOrSave();
};
