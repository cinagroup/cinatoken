function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** OpenAI Chat streams only: request the terminal usage chunk for billing. */
export function ensureOpenAiStreamIncludesUsage(
	body: Record<string, unknown>,
): Record<string, unknown> {
	if (body.stream !== true) return body;
	const current = isRecord(body.stream_options) ? body.stream_options : {};
	return {
		...body,
		stream_options: {
			...current,
			include_usage: true,
		},
	};
}
