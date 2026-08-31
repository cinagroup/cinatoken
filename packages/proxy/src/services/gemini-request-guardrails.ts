import type {
	GatewayRepositories,
	GuardrailPreflightResult,
} from '@octafuse/core';
import { runRequestGuardrails } from './request-guardrails';

export type GeminiContentAction = 'generateContent' | 'streamGenerateContent';

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The shared guardrail engine scans OpenAI-compatible prompt roots and uses the
 * body `stream` flag. Native Gemini carries those semantics in `contents`,
 * `systemInstruction`, and the path action, so adapt them without leaking the
 * synthetic fields to the provider.
 */
function toSharedGuardrailBody(
	body: Record<string, unknown>,
	action: GeminiContentAction,
): Record<string, unknown> {
	const prompt: Record<string, unknown> = {};
	for (const key of ['contents', 'systemInstruction', 'system_instruction']) {
		if (hasOwn(body, key)) prompt[key] = body[key];
	}
	return {
		...body,
		input: prompt,
		stream: action === 'streamGenerateContent',
	};
}

function restoreGeminiBody(
	original: Record<string, unknown>,
	evaluated: Record<string, unknown>,
): Record<string, unknown> {
	const restored = { ...evaluated };
	const prompt = isRecord(evaluated.input) ? evaluated.input : {};
	for (const key of ['contents', 'systemInstruction', 'system_instruction']) {
		if (hasOwn(original, key) && hasOwn(prompt, key)) restored[key] = prompt[key];
	}
	if (hasOwn(original, 'input')) restored.input = original.input;
	else delete restored.input;
	if (hasOwn(original, 'stream')) restored.stream = original.stream;
	else delete restored.stream;
	return restored;
}

export async function runGeminiRequestGuardrails(
	repositories: GatewayRepositories,
	params: {
		workspaceId: string;
		userId: string;
		apiKeyId: string;
		modelId: string;
		body: Record<string, unknown>;
		action: GeminiContentAction;
		correlationId: string;
		now: Date;
	},
): Promise<GuardrailPreflightResult> {
	const result = await runRequestGuardrails(repositories, {
		workspaceId: params.workspaceId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		modelIds: [params.modelId],
		body: toSharedGuardrailBody(params.body, params.action),
		correlationId: params.correlationId,
		now: params.now,
	});
	if (!result.ok) return result;
	return { ...result, body: restoreGeminiBody(params.body, result.body) };
}

/** Expose Gemini's nested output ceiling to the shared conservative estimator. */
export function geminiBodyForBudgetEstimate(
	body: Record<string, unknown>,
): Record<string, unknown> {
	const generationConfig = isRecord(body.generationConfig)
		? body.generationConfig
		: isRecord(body.generation_config)
			? body.generation_config
			: null;
	const rawLimit = generationConfig?.maxOutputTokens ?? generationConfig?.max_output_tokens;
	if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 0) return body;
	return { ...body, max_output_tokens: rawLimit };
}
