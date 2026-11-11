import { ChangeDetectionStrategy, Component, computed, effect, inject, model } from '@angular/core';
import { activeColor } from '../../../../core/chess/fen.util';
import { formatScore } from '../../../../core/engine/uci';
import { EngineStore } from '../../state/engine.store';
import { MoveTreeStore } from '../../state/move-tree.store';
import { TablebaseStore } from '../../state/tablebase.store';
import { AuthService } from '../../../../core/services/auth.service';
import { NotificationService } from '../../../../core/services/notification.service';

const TABLEBASE_SIGN_IN = 'You must be signed in to use the tablebase.';

@Component({
	selector: 'app-engine-bar',
	standalone: true,
	imports: [],
	templateUrl: './engine-bar.component.html',
	styleUrl: './engine-bar.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EngineBarComponent {
	readonly engine = inject(EngineStore);
	private readonly tree = inject(MoveTreeStore);
	readonly tablebase = inject(TablebaseStore);
	private readonly auth = inject(AuthService);
	private readonly notify = inject(NotificationService);
	readonly settingsOpen = model(false);

	readonly tablebaseOpen = model(false);

	readonly solutionHidden = computed(() => this.tree.solutionHiddenAtCurrent());

	readonly score = computed(() => {
		const best = this.engine.best();
		return best ? formatScore(best, activeColor(this.engine.positionFen())) : '';
	});
	readonly showDepth = computed(() => this.engine.enabled() && this.engine.depth() > 0);

	readonly tablebaseUnavailable = computed<string | null>(() => {
		if (this.solutionHidden()) {
			return 'Endgame tablebase disabled until the solution is shown';
		}
		if (!this.tablebase.inRange()) {
			return 'Endgame tablebase — more pieces on the board than the tables hold';
		}
		return null;
	});

	readonly tablebaseHint = computed(() => this.tablebaseUnavailable() ?? 'Endgame tablebase');

	constructor() {
		// Engine eval would give away the hidden solution, so force it off while hidden.
		effect(() => {
			if (this.solutionHidden() && this.engine.enabled()) {
				this.engine.setEnabled(false);
			}
		});

		// Signing out closes it too: the tablebase is read through the server, for signed-in accounts only.
		effect(() => {
			if ((this.solutionHidden() || !this.auth.isLoggedIn()) && this.tablebaseOpen()) {
				this.tablebaseOpen.set(false);
			}
		});
	}

	toggle(): void {
		if (this.solutionHidden()) return;
		this.engine.setEnabled(!this.engine.enabled());
	}

	toggleSettings(): void {
		const next = !this.settingsOpen();
		if (next) {
			this.tablebaseOpen.set(false);
		}
		this.settingsOpen.set(next);
	}

	toggleTablebase(): void {
		if (this.tablebaseUnavailable()) return;
		if (!this.tablebaseOpen() && !this.auth.isLoggedIn()) {
			this.notify.info(TABLEBASE_SIGN_IN);
			return;
		}

		const next = !this.tablebaseOpen();
		if (next) {
			this.settingsOpen.set(false);
		}
		this.tablebaseOpen.set(next);
	}
}
