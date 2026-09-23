import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MAX_MULTI_PV, hashStepsFor } from '../../../../core/engine/engine-capabilities';
import { AgentBridgeService } from '../../../../core/agent/agent-bridge.service';
import { EngineStore } from '../../state/engine.store';

interface StepSlider {
	readonly index: number;
	readonly max: number;
	readonly label: string;
	readonly markerPercent: number | null;
}

@Component({
	selector: 'app-engine-settings',
	standalone: true,
	imports: [],
	templateUrl: './engine-settings.component.html',
	styleUrl: './engine-settings.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EngineSettingsComponent {
	readonly engine = inject(EngineStore);
	private readonly bridge = inject(AgentBridgeService);

	readonly maxMultiPv = MAX_MULTI_PV;

	readonly options = computed(() => {
		const local = this.bridge.embedded() ? this.bridge.engines() : [];
		return local.map((card) => ({
			value: `local:${card.id}`,
			label: card.reportedName ?? card.name,
			detail: card.author,
		}));
	});

	readonly chosen = computed(() => {
		const local = this.engine.localEngine();
		return local ? `local:${local.id}` : this.engine.definition().id;
	});

	readonly searchTime = computed<StepSlider>(() => {
		const steps = this.engine.searchTimeSteps;
		const seconds = this.engine.settings().searchSeconds;
		const index = Math.max(0, steps.indexOf(seconds));
		return {
			index,
			max: steps.length - 1,
			label: Number.isFinite(seconds) ? `${seconds}s` : 'Unlimited',
			markerPercent: null,
		};
	});

	onSearchTime(event: Event): void {
		const index = readSlider(event);
		this.engine.updateSettings({ searchSeconds: this.engine.searchTimeSteps[index] });
	}

	readonly multiPv = computed(() => this.engine.settings().multiPv);

	onMultiPv(event: Event): void {
		this.engine.updateSettings({ multiPv: readSlider(event) });
	}

	readonly threads = computed<StepSlider>(() => {
		const max = this.engine.maxThreads();
		const value = this.engine.settings().threads;
		return {
			index: value,
			max,
			label: `${value} / ${max}`,
			markerPercent: percentOf(this.engine.recommendedThreads() - 1, max - 1),
		};
	});

	onThreads(event: Event): void {
		this.engine.updateSettings({ threads: readSlider(event) });
	}

	readonly hashSteps = computed(() => hashStepsFor(this.engine.definition()));

	readonly hash = computed<StepSlider>(() => {
		const steps = this.hashSteps();
		const value = this.engine.settings().hashMb;
		const index = Math.max(0, steps.indexOf(value));
		return {
			index,
			max: steps.length - 1,
			label: `${value} MB`,
			markerPercent: percentOf(steps.indexOf(this.engine.recommendedHashMb()), steps.length - 1),
		};
	});

	onHash(event: Event): void {
		this.engine.updateSettings({ hashMb: this.hashSteps()[readSlider(event)] });
	}

	// Board-local only, deliberately not saved as the default: a second board is meant to be
	// able to run a different engine.
	onEngine(event: Event): void {
		const value = (event.target as HTMLSelectElement).value;
		if (value.startsWith('local:')) {
			this.engine.selectEngine('local', Number(value.slice('local:'.length)));
			return;
		}
		this.engine.selectEngine(value);
	}
}

function readSlider(event: Event): number {
	return Number.parseInt((event.target as HTMLInputElement).value, 10);
}

function percentOf(index: number, max: number): number | null {
	if (max <= 0 || index < 0 || index > max) return null;
	return (index / max) * 100;
}
