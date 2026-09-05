export type BoundedJsonRequestFailureKind =
	| 'invalid_json'
	| 'invalid_request'
	| 'payload_too_large'
	| 'cancelled';

export class BoundedJsonRequestError extends Error {
	constructor(
		readonly kind: BoundedJsonRequestFailureKind,
		message: string,
	) {
		super(message);
		this.name = 'BoundedJsonRequestError';
	}
}

function declaredContentLength(request: Request): number | null {
	const raw = request.headers.get('content-length');
	if (raw == null || raw.trim() === '') return null;
	if (!/^\d+$/.test(raw.trim())) {
		throw new BoundedJsonRequestError('invalid_request', 'Invalid Content-Length header');
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new BoundedJsonRequestError('invalid_request', 'Invalid Content-Length header');
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

async function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal.aborted) {
		throw new BoundedJsonRequestError('cancelled', 'JSON request was cancelled');
	}
	return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener('abort', onAbort);
		const onAbort = () => {
			cleanup();
			reject(new BoundedJsonRequestError('cancelled', 'JSON request was cancelled'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		reader.read().then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

/** Read one strict, bounded JSON object without trusting Content-Length. */
export async function readBoundedJsonObject(
	request: Request,
	params: { maxBytes: number; label: string },
): Promise<Record<string, unknown>> {
	const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	if (mediaType !== 'application/json') {
		throw new BoundedJsonRequestError(
			'invalid_request',
			`${params.label} must use Content-Type: application/json`,
		);
	}
	const declaredLength = declaredContentLength(request);
	if (declaredLength != null && declaredLength > params.maxBytes) {
		await request.body?.cancel('bounded_json_request_too_large').catch(() => undefined);
		throw new BoundedJsonRequestError(
			'payload_too_large',
			`${params.label} must be at most ${params.maxBytes} bytes`,
		);
	}
	if (!request.body) {
		throw new BoundedJsonRequestError('invalid_json', 'Missing JSON body');
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let receivedBytes = 0;
	try {
		for (;;) {
			const { done, value } = await readWithAbort(reader, request.signal);
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > params.maxBytes) {
				throw new BoundedJsonRequestError(
					'payload_too_large',
					`${params.label} must be at most ${params.maxBytes} bytes`,
				);
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(receivedBytes);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			throw new BoundedJsonRequestError('invalid_json', 'JSON body must be valid UTF-8');
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch {
			throw new BoundedJsonRequestError('invalid_json', 'Invalid JSON body');
		}
		if (!isRecord(parsed)) {
			throw new BoundedJsonRequestError('invalid_request', 'JSON body must be an object');
		}
		return parsed;
	} catch (error) {
		await reader.cancel('bounded_json_request_rejected').catch(() => undefined);
		if (error instanceof BoundedJsonRequestError) throw error;
		if (request.signal.aborted) {
			throw new BoundedJsonRequestError('cancelled', 'JSON request was cancelled');
		}
		throw new BoundedJsonRequestError('invalid_json', 'Invalid JSON body');
	} finally {
		reader.releaseLock();
	}
}
