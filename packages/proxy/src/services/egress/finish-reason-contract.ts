export type CanonicalFinishReason =
	| 'tool_calls'
	| 'stop'
	| 'length'
	| 'content_filter'
	| 'error';

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_NATIVE_FINISH_REASON_LENGTH = 128;

/** Keep provider-controlled values bounded before they enter immutable logs. */
export function normalizeNativeFinishReason(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed
		&& trimmed.length <= MAX_NATIVE_FINISH_REASON_LENGTH
		&& !CONTROL_CHAR_PATTERN.test(trimmed)
		? trimmed
		: null;
}

/** OpenRouter's normalized Chat finish-reason vocabulary. */
export function normalizeCanonicalFinishReason(value: unknown): CanonicalFinishReason | null {
	switch (value) {
		case 'tool_calls':
		case 'stop':
		case 'length':
		case 'content_filter':
		case 'error':
			return value;
		default:
			return null;
	}
}

/** Map only Anthropic stop reasons whose normalized meaning is unambiguous. */
export function finishReasonsFromAnthropicStopReason(value: unknown): {
	finishReason: CanonicalFinishReason | null;
	nativeFinishReason: string | null;
} {
	const nativeFinishReason = normalizeNativeFinishReason(value);
	let finishReason: CanonicalFinishReason | null = null;
	switch (nativeFinishReason) {
		case 'end_turn':
		case 'stop_sequence':
			finishReason = 'stop';
			break;
		case 'max_tokens':
		case 'model_context_window_exceeded':
			finishReason = 'length';
			break;
		case 'tool_use':
			finishReason = 'tool_calls';
			break;
		case 'refusal':
			finishReason = 'content_filter';
			break;
		// `pause_turn` and `compaction` are protocol-specific continuation
		// states. Preserve the native fact without inventing a Chat meaning.
		default:
			break;
	}
	return { finishReason, nativeFinishReason };
}
