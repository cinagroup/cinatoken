/** Error raised after an upstream response exceeded the local buffering ceiling. */
export class UpstreamResponseBodyTooLargeError extends Error {
	constructor(readonly upstreamStatus: number) {
		super('Upstream response body exceeds the configured limit');
		this.name = 'UpstreamResponseBodyTooLargeError';
	}
}

/**
 * Buffer a response body without trusting Content-Length. The reader is
 * cancelled as soon as the declared or observed byte ceiling is crossed.
 */
export async function responseTextWithinLimit(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel('upstream_response_too_large').catch(() => undefined);
		throw new UpstreamResponseBodyTooLargeError(response.status);
	}
	if (!response.body) return '';

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				await reader.cancel('upstream_response_too_large').catch(() => undefined);
				throw new UpstreamResponseBodyTooLargeError(response.status);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export function resolveResponseByteLimit(configured: number | undefined, hardLimit: number): number {
	return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
		? Math.min(hardLimit, Math.floor(configured))
		: hardLimit;
}
