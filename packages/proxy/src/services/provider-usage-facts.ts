import type { UsageFromStream } from './proxy';

export type ProviderUsageFacts = Readonly<{
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}>;

function safeTokens(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Explicit OpenAI-compatible counters only; heuristic gateway usage remains unproved. */
export function providerUsageFacts(usage: UsageFromStream): ProviderUsageFacts | null {
	if (usage.cancelled || usage.stream_error || typeof usage.raw_usage !== 'string'
		|| usage.raw_usage.length === 0 || usage.raw_usage.length > 256 * 1024) return null;
	let raw: unknown;
	try { raw = JSON.parse(usage.raw_usage); } catch { return null; }
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const source = raw as Record<string, unknown>;
	for (const field of ['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens']) {
		if (source[field] != null && !safeTokens(source[field])) return null;
	}
	if ((source.prompt_tokens != null && source.input_tokens != null
			&& source.prompt_tokens !== source.input_tokens)
		|| (source.completion_tokens != null && source.output_tokens != null
			&& source.completion_tokens !== source.output_tokens)) return null;
	const input = source.prompt_tokens ?? source.input_tokens;
	const output = source.completion_tokens ?? source.output_tokens;
	if (!safeTokens(input) || !safeTokens(output)) return null;
	const promptDetails = source.prompt_tokens_details;
	if (promptDetails != null && (typeof promptDetails !== 'object' || Array.isArray(promptDetails))) return null;
	const details = (promptDetails ?? {}) as Record<string, unknown>;
	const cacheRead = details.cached_tokens ?? 0;
	const cacheWrite = details.cache_creation_tokens ?? 0;
	if (!safeTokens(cacheRead) || !safeTokens(cacheWrite)
		|| !safeTokens(cacheRead + cacheWrite) || !safeTokens(input + output)
		|| ![usage.input_tokens, usage.output_tokens, usage.cache_read_tokens,
			usage.cache_write_tokens, usage.total_tokens].every(safeTokens)
		|| !safeTokens(usage.input_tokens + usage.output_tokens)
		|| usage.output_tokens !== output || usage.cache_read_tokens !== cacheRead
		|| usage.cache_write_tokens !== cacheWrite
		|| usage.input_tokens < cacheRead + cacheWrite
		|| (usage.input_tokens !== input && usage.input_tokens !== input + cacheRead + cacheWrite)
		|| (source.total_tokens != null && (
			source.total_tokens !== usage.total_tokens
			|| (source.total_tokens !== input + output
				&& source.total_tokens !== usage.input_tokens + usage.output_tokens)
		))) return null;
	return {
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		cacheReadTokens: usage.cache_read_tokens,
		cacheWriteTokens: usage.cache_write_tokens,
	};
}
