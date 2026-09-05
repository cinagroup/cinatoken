export type OpenAiResponseServiceTier = 'default' | 'flex' | 'priority' | null;
export type AnthropicResponseServiceTier = 'standard' | 'flex' | 'priority' | null;
export type ResponseTextSpeed = 'fast' | 'standard' | null;

/** Keep the response contract closed even when an upstream sends private labels. */
export function normalizeResponseTextSpeed(value: unknown): ResponseTextSpeed {
	return value === 'fast' || value === 'standard' ? value : null;
}

/** Normalize provider-native labels to OpenRouter's OpenAI-compatible response contract. */
export function normalizeOpenAiResponseServiceTier(value: unknown): OpenAiResponseServiceTier {
	if (value === 'flex') return 'flex';
	if (value === 'priority' || value === 'fast') return 'priority';
	if (value === 'default' || value === 'standard' || value === 'auto') return 'default';
	return null;
}

/** Anthropic's public Messages contract names the base tier `standard`. */
export function normalizeAnthropicResponseServiceTier(value: unknown): AnthropicResponseServiceTier {
	const normalized = normalizeOpenAiResponseServiceTier(value);
	return normalized === 'default' ? 'standard' : normalized;
}
