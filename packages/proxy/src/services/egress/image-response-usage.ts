import { parseOpenAiImageUsage, type ImageTokenUsage } from '@octafuse/core';
import { IMAGE_JSON_STRUCTURE_LIMITS } from '../json-structure-budget';
import { isJsonString, JsonStringPages } from './json-string-pages';
import { jsonStringNumber } from './json-string-number';
import { jsonBodyByteLength, materializeJsonBodyText } from './stream-json-body';

/** Complete normalized audit JSON, UTF-8 bytes; never silently truncate. */
export const IMAGE_MAX_USAGE_JSON_BYTES = 64 * 1024;
export class ImageUsageLimitError extends Error {
	constructor() {
		super(`Image usage audit JSON must be at most ${IMAGE_MAX_USAGE_JSON_BYTES} UTF-8 bytes`);
		this.name = 'ImageUsageLimitError';
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
	&& !Array.isArray(value) && !(value instanceof JsonStringPages);
// Normalization can add aggregate aliases; use the same internal traversal
// allowance as the ordinary image response encoder, not a new wire limit.
const USAGE_LIMITS = Object.freeze({ maxDepth: IMAGE_JSON_STRUCTURE_LIMITS.maxDepth, maxNodes: 3 * IMAGE_JSON_STRUCTURE_LIMITS.maxNodes + 16 });

/** Validated Images JSON only. Core remains the counter/floor/cache authority. */
export function parseImageUsageFromAnyShape(body: unknown, checkActive?: () => void): ImageTokenUsage | null {
	checkActive?.();
	if (!isRecord(body) || !isRecord(body.usage)) return null;
	const u = body.usage;
	const numeric = (value: unknown): number => isJsonString(value) ? jsonStringNumber(value, checkActive) : typeof value === 'number' ? value : 0;
	const input = isRecord(u.input_tokens_details) ? u.input_tokens_details : null;
	const output = isRecord(u.output_tokens_details) ? u.output_tokens_details : null;
	const inputTotal = u.input_tokens ?? u.prompt_tokens, outputTotal = u.output_tokens ?? u.completion_tokens;
	// Admit the final alias-expanded audit before native string construction or
	// counter scanning. JSON escaping and UTF-8 expansion count; wire whitespace
	// and overwritten values do not. Byte/depth/node wire admission is separate.
	const raw = { ...u };
	if (inputTotal === undefined) delete raw.input_tokens; else raw.input_tokens = inputTotal;
	if (outputTotal === undefined) delete raw.output_tokens; else raw.output_tokens = outputTotal;
	if (jsonBodyByteLength(raw, USAGE_LIMITS, checkActive) > IMAGE_MAX_USAGE_JSON_BYTES) throw new ImageUsageLimitError();
	// Never put unknown objects or long strings into Core's native serializer.
	// Preserve details presence and nullish cached-field precedence exactly.
	const counted = parseOpenAiImageUsage({ usage: {
		input_tokens: numeric(inputTotal), output_tokens: numeric(outputTotal), total_tokens: numeric(u.total_tokens),
		input_tokens_details: input ? {
			text_tokens: numeric(input.text_tokens), image_tokens: numeric(input.image_tokens),
			cached_text_tokens: numeric(input.cached_text_tokens ?? input.cache_tokens), cached_image_tokens: numeric(input.cached_image_tokens),
		} : null,
		output_tokens_details: output ? { image_tokens: numeric(output.image_tokens) } : null,
	} });
	if (!counted) return null;
	// Match the old spread + alias overrides, including removal of a null field
	// when its fallback is absent. Keep existing key positions and all unknown data.
	return { ...counted, raw_usage: materializeJsonBodyText(raw, USAGE_LIMITS, checkActive) };
}
