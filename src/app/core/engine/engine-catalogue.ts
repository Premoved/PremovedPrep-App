export type EngineKind = 'local';

export interface EngineDefinition {
	readonly id: string;
	readonly kind: EngineKind;
	readonly label: string;
	readonly shortLabel: string;
	readonly threads: boolean;
	readonly maxHashMb: number;
}

export const ENGINE_CATALOGUE: readonly EngineDefinition[] = [
	{
		id: 'local',
		kind: 'local',
		label: 'Local engine',
		shortLabel: 'Local engine',
		threads: true,
		maxHashMb: 16384,
	},
];

export const DEFAULT_ENGINE_ID = 'local';

// Falls back to the default instead of throwing, because the id can come from stored preferences.
export function engineById(id: string): EngineDefinition {
	const found = ENGINE_CATALOGUE.find((engine) => engine.id === id);
	if (found) return found;
	return ENGINE_CATALOGUE.find((engine) => engine.id === DEFAULT_ENGINE_ID) ?? ENGINE_CATALOGUE[0];
}
