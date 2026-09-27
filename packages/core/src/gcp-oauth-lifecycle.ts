/** Local OAuth safety ceiling, not an accepted production SLO. */
export const GCP_OAUTH_TIMEOUT_MS = 30_000;
export const GCP_OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;

export class GcpTokenExchangeError extends Error {
	constructor(readonly code: 'cancelled' | 'timeout' | 'failed' | 'invalid_response' | 'response_too_large' | 'http_error', readonly status?: number) {
		const messages = {
			cancelled: 'GCP token exchange cancelled',
			timeout: 'GCP token exchange timed out',
			failed: 'GCP token exchange failed',
			invalid_response: 'GCP token exchange returned an invalid response',
			response_too_large: 'GCP token exchange response exceeds the limit',
			http_error: 'GCP token exchange was rejected',
		};
		super(messages[code]);
		this.name = 'GcpTokenExchangeError';
	}
}

/** No shared I/O: one invocation owns signing, fetch, body consumption and cleanup. */
export function createGcpOAuthLifecycle(parentSignal?: AbortSignal, timeoutMs = GCP_OAUTH_TIMEOUT_MS) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GCP_OAUTH_TIMEOUT_MS) {
		throw new RangeError('Invalid GCP OAuth timeout');
	}
	const controller = new AbortController();
	const deadlineAtMs = Date.now() + timeoutMs;
	let closed = false;
	const stop = (code: 'timeout' | 'cancelled') => controller.abort(new GcpTokenExchangeError(code));
	const onParentAbort = () => stop('cancelled');
	if (parentSignal?.aborted) onParentAbort();
	else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
	const timer = setTimeout(() => stop('timeout'), timeoutMs);
	if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
	const check = (): void => {
		if (!controller.signal.aborted && Date.now() >= deadlineAtMs) stop('timeout');
		controller.signal.throwIfAborted();
		if (closed) throw new GcpTokenExchangeError('cancelled');
	};
	async function wait<T>(operation: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
		check();
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const cleanup = () => controller.signal.removeEventListener('abort', onAbort);
			const onAbort = () => { settled = true; cleanup(); reject(controller.signal.reason); };
			controller.signal.addEventListener('abort', onAbort, { once: true });
			if (controller.signal.aborted) { onAbort(); return; }
			void Promise.resolve().then(() => { check(); return operation(); }).then(value => {
				cleanup();
				if (settled) { discard?.(value); return; }
				try { check(); } catch (error) { settled = true; discard?.(value); reject(error); return; }
				settled = true;
				resolve(value);
			}, error => { cleanup(); settled = true; reject(error); }).catch(reject);
		});
	}
	return {
		signal: controller.signal, check, wait,
		dispose() {
			closed = true;
			clearTimeout(timer);
			parentSignal?.removeEventListener('abort', onParentAbort);
		},
	};
}

export type GcpOAuthLifecycle = ReturnType<typeof createGcpOAuthLifecycle>;

export function discardGcpOAuthResponse(response: Response): void {
	void response.body?.cancel('gcp_oauth_stopped').catch(() => undefined);
}

/** Count decoded transport bytes, not a possibly absent or dishonest Content-Length. */
export async function readGcpOAuthResponse(response: Response, owner: GcpOAuthLifecycle): Promise<string> {
	try { owner.check(); } catch (error) { discardGcpOAuthResponse(response); throw error; }
	if (Number(response.headers.get('content-length')) > GCP_OAUTH_MAX_RESPONSE_BYTES) {
		discardGcpOAuthResponse(response);
		throw new GcpTokenExchangeError('response_too_large');
	}
	if (!response.body) return '';
	const reader = response.body.getReader();
	const bytes = new Uint8Array(GCP_OAUTH_MAX_RESPONSE_BYTES);
	let size = 0;
	let eof = false;
	try {
		while (true) {
			const { done, value } = await owner.wait(() => reader.read());
			if (done) { eof = true; break; }
			if (value.byteLength > bytes.byteLength - size) throw new GcpTokenExchangeError('response_too_large');
			bytes.set(value, size);
			size += value.byteLength;
		}
		owner.check();
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
	} finally {
		// A custom/tee transport may never acknowledge cancellation. Observe it,
		// but do not let it keep the token operation (or the next request) alive.
		if (!eof) void reader.cancel('gcp_oauth_stopped').catch(() => undefined);
		reader.releaseLock();
	}
}
