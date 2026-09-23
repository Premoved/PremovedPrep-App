import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { formatGameDate, hasGameHeaders } from '../../../../core/chess/game-headers';
import { MoveTreeStore } from '../../state/move-tree.store';
import { ArchiveNameService } from '../../../../core/services/archive-name.service';
import { DatabaseIconComponent } from '../../../../shared/database-badge/database-icon.component';

@Component({
	selector: 'app-game-header',
	standalone: true,
	imports: [DatabaseIconComponent],
	templateUrl: './game-header.component.html',
	styleUrl: './game-header.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameHeaderComponent {
	readonly scope = input<'game' | 'database'>('game');

	readonly tree = inject(MoveTreeStore);

	readonly archive = inject(ArchiveNameService);

	readonly hasHeaders = computed(() => hasGameHeaders(this.tree.headers()));

	readonly date = computed(() => formatGameDate(this.tree.headers().date));

	// A study or analysis has no players: Event and Annotator hold its title and author.
	readonly document = computed(() => {
		const headers = this.tree.headers();
		return !headers.white && !headers.black && Boolean(headers.event || headers.annotator);
	});
}
