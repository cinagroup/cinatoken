export type RequestBodyLoggingMode = 'off' | 'redacted';

/**
 * Request bodies may contain prompts, credentials, personal data, or uploaded
 * document contents. Persist them only after an explicit operator opt-in.
 */
export function resolveRequestBodyLoggingMode(value: unknown): RequestBodyLoggingMode {
	return typeof value === 'string' && value.trim().toLowerCase() === 'redacted'
		? 'redacted'
		: 'off';
}

export function applyRequestBodyLoggingPolicy(
	value: string | null | undefined,
	mode: RequestBodyLoggingMode | undefined
): string | null {
	return mode === 'redacted' ? value ?? null : null;
}
