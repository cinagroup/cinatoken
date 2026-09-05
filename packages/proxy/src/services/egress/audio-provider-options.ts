import type { RouteResult } from '../model-router';

export type AudioProviderOptionScalar = string | number | boolean;

export interface AudioProviderOptionObject {
	readonly [key: string]: AudioProviderOptionValue;
}

export interface AudioProviderOptionArray extends ReadonlyArray<AudioProviderOptionValue> {}

export type AudioProviderOptionValue =
	| AudioProviderOptionScalar
	| null
	| AudioProviderOptionArray
	| AudioProviderOptionObject;

export type AudioProviderOptions<Value = AudioProviderOptionValue> = Readonly<
	Record<string, Readonly<Record<string, Value>>>
>;

function canonicalProviderOptionKey(value: string): string {
	return value.trim().toLocaleLowerCase();
}

/** Resolve options for exactly one concrete route attempt. */
export function resolveAudioProviderOptionsForRoute<Value>(
	options: AudioProviderOptions<Value> | undefined,
	route: Pick<RouteResult, 'providerId' | 'providerName' | 'endpoint'>,
): Readonly<Record<string, Value>> {
	if (!options) return {};
	const endpointProviderSlug = route.endpoint?.providerSlug ?? '';
	const candidates = [route.providerId, route.providerName, endpointProviderSlug]
		.map(canonicalProviderOptionKey)
		.filter(Boolean);
	for (const [provider, value] of Object.entries(options)) {
		if (candidates.includes(canonicalProviderOptionKey(provider))) return value;
	}
	return {};
}
