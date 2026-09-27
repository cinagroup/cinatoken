import { IMAGE_MAX_PROMPT_CHARS, normalizeImageCommonParams } from './egress/openai-images-driver';
import { JsonStringPages, trimJsonString } from './egress/json-string-pages';

/**
 * Generation ingress boundary only. Apply the existing trim/length contract
 * before materializing a paged prompt; Guardrails and pricing still see the
 * same bounded native prompt. Wrong types and the other fields retain the
 * shared validator's precedence. The parser has already validated full EOF.
 */
export function normalizeImageGenerationParams(
	input: Parameters<typeof normalizeImageCommonParams>[0],
): ReturnType<typeof normalizeImageCommonParams> {
	if (!(input.prompt instanceof JsonStringPages)) return normalizeImageCommonParams(input);
	const trimmed = trimJsonString(input.prompt);
	if (trimmed.length > IMAGE_MAX_PROMPT_CHARS) {
		return { ok: false, error: `prompt must be at most ${IMAGE_MAX_PROMPT_CHARS} characters` };
	}
	const prompt = typeof trimmed === 'string' ? trimmed : trimmed.materialize();
	return normalizeImageCommonParams({ ...input, prompt });
}
