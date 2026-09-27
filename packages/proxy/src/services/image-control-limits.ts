import { IMAGE_JSON_STRUCTURE_LIMITS } from './json-structure-budget';
import { isJsonString, materializeJsonStringTree } from './egress/json-string-pages';
import { jsonBodyByteLength } from './egress/stream-json-body';

/** Public Images JSON ingress only; decoded UTF-16 units BEFORE trimming. */
export const IMAGE_CONTROL_MAX_CHARS = Object.freeze({
	model: 256,
	n: 32,
	size: 64,
	quality: 64,
	background: 64,
	service_tier: 64,
});
/** UTF-8 bytes of compact JSON for the final provider value, including keys. */
export const IMAGE_PROVIDER_MAX_JSON_BYTES = 16 * 1024;

export class ImageControlLimitError extends Error {
	constructor(readonly field: string, readonly limit: number, readonly unit: 'characters' | 'JSON bytes') {
		super(`${field} must be at most ${limit} ${unit}`);
		this.name = 'ImageControlLimitError';
	}
}

/**
 * Called only after full JSON/byte/structure validation and duplicate resolution.
 * Admit every native boundary before materializing any of them. Wrong-type
 * scalar controls stay paged inside their containers for the existing validators;
 * provider needs a native subtree, so bound its entire compact representation.
 * No request values are included in errors. Prompt retains its separate contract.
 */
export function prepareImageNativeControls(body: Record<string, unknown>, signal?: AbortSignal): void {
	const checkActive = () => signal?.throwIfAborted();
	checkActive();
	for (const [field, limit] of Object.entries(IMAGE_CONTROL_MAX_CHARS)) {
		const value = body[field];
		if (isJsonString(value) && value.length > limit) throw new ImageControlLimitError(field, limit, 'characters');
	}
	if (Object.hasOwn(body, 'provider')
		&& jsonBodyByteLength(body.provider, IMAGE_JSON_STRUCTURE_LIMITS, checkActive) > IMAGE_PROVIDER_MAX_JSON_BYTES) {
		throw new ImageControlLimitError('provider', IMAGE_PROVIDER_MAX_JSON_BYTES, 'JSON bytes');
	}
	for (const field of Object.keys(IMAGE_CONTROL_MAX_CHARS)) {
		if (isJsonString(body[field])) body[field] = materializeJsonStringTree(body[field]);
	}
	if (Object.hasOwn(body, 'provider')) body.provider = materializeJsonStringTree(body.provider);
}
