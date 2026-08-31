/** Shared, Workers-safe bounds for Tool provider responses and mapped outputs. */

export const TOOL_PROVIDER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Keep enough headroom for the route's `{ data, cost }` envelope and the
 * Guardrail response serializer, whose hard ceiling is 2 MiB.
 */
export const TOOL_PROVIDER_OUTPUT_MAX_BYTES = TOOL_PROVIDER_RESPONSE_MAX_BYTES - 16 * 1024;

export const TOOL_PROVIDER_RESPONSE_TOO_LARGE_MESSAGE =
	'Tool provider response exceeded the safe size limit';
export const TOOL_PROVIDER_OUTPUT_TOO_LARGE_MESSAGE =
	'Tool provider output exceeded the safe size limit';

const RESPONSE_CANCEL_REASON = 'tool_provider_response_too_large';

type ProviderErrorConstructor<TError extends Error> = new (
	message: string,
	status: number,
	provider: string,
) => TError;

type ProviderBoundOptions<TError extends Error> = {
	provider: string;
	errorConstructor: ProviderErrorConstructor<TError>;
	maxBytes?: number;
};

function normalizedMaxBytes(maxBytes: number | undefined, fallback: number): number {
	if (maxBytes == null) return fallback;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new RangeError('maxBytes must be a positive safe integer');
	}
	return maxBytes;
}

function declaredContentLength(response: Response): number | null {
	const raw = response.headers.get('content-length')?.trim();
	if (!raw || !/^\d+$/u.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : null;
}

function providerError<TError extends Error>(
	options: ProviderBoundOptions<TError>,
	message: string,
): TError {
	return new options.errorConstructor(message, 502, options.provider);
}

async function cancelResponseBody(response: Response): Promise<void> {
	if (!response.body) return;
	try {
		await response.body.cancel(RESPONSE_CANCEL_REASON);
	} catch {
		// The safety decision is authoritative even when an upstream stream is
		// already closed or rejects cancellation.
	}
}

/**
 * Decode a provider response incrementally while enforcing a byte ceiling.
 * Both a declared oversize body and a body that crosses the limit mid-stream
 * are cancelled before a stable provider error is raised.
 */
export async function readToolProviderResponseText<TError extends Error>(
	response: Response,
	options: ProviderBoundOptions<TError>,
): Promise<string> {
	const maxBytes = normalizedMaxBytes(options.maxBytes, TOOL_PROVIDER_RESPONSE_MAX_BYTES);
	const declaredBytes = declaredContentLength(response);
	if (declaredBytes != null && declaredBytes > maxBytes) {
		await cancelResponseBody(response);
		throw providerError(options, TOOL_PROVIDER_RESPONSE_TOO_LARGE_MESSAGE);
	}

	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const textChunks: string[] = [];
	let bytesRead = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > maxBytes) {
				try {
					await reader.cancel(RESPONSE_CANCEL_REASON);
				} catch {
					// Preserve the deterministic safe failure even if cancellation races
					// with an upstream close/error.
				}
				throw providerError(options, TOOL_PROVIDER_RESPONSE_TOO_LARGE_MESSAGE);
			}
			textChunks.push(decoder.decode(value, { stream: true }));
		}
		textChunks.push(decoder.decode());
		return textChunks.join('');
	} finally {
		reader.releaseLock();
	}
}

/**
 * Bound the normalized value before callers pass it to `Response.json()` or
 * the output Guardrail serializer. Provider inputs have already been capped,
 * so this serialization cannot grow without an upstream byte ceiling.
 */
export function assertToolProviderOutputWithinLimit<TError extends Error>(
	value: unknown,
	options: ProviderBoundOptions<TError>,
): void {
	const maxBytes = normalizedMaxBytes(options.maxBytes, TOOL_PROVIDER_OUTPUT_MAX_BYTES);
	const serialized = JSON.stringify(value);
	if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
		throw providerError(options, TOOL_PROVIDER_OUTPUT_TOO_LARGE_MESSAGE);
	}
}
