import { RequestExecutionStoppedError, type RequestDeadline } from '@octafuse/core';
import { AdminServiceError } from './errors';

/** Local preview ceiling, not an accepted production SLO or buyer budget. */
export const PLAYGROUND_REQUEST_DEADLINE_MS = 300_000;
export const PLAYGROUND_MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;

export function playgroundStoppedError(error: RequestExecutionStoppedError): AdminServiceError {
	return error.reason === 'deadline_exceeded'
		? new AdminServiceError(504, 'Playground request timed out')
		: new AdminServiceError(499, 'Playground request cancelled');
}

export function discardPlaygroundResponse(response: Response): void {
	void response.body?.cancel('playground_request_stopped').catch(() => undefined);
}

/** Only control JSON is buffered; returned media/SSE remains streamed. */
export async function readPlaygroundJson(response: Response, owner: RequestDeadline): Promise<unknown> {
	try { owner.throwIfStopped(); } catch (error) { discardPlaygroundResponse(response); throw error; }
	if (Number(response.headers.get('content-length')) > PLAYGROUND_MAX_CONTROL_RESPONSE_BYTES) {
		discardPlaygroundResponse(response);
		throw new AdminServiceError(502, 'Playground upstream control response exceeds the limit');
	}
	if (!response.body) throw new AdminServiceError(502, 'Playground upstream returned invalid JSON');
	const reader = response.body.getReader();
	const bytes = new Uint8Array(PLAYGROUND_MAX_CONTROL_RESPONSE_BYTES);
	let size = 0;
	let eof = false;
	try {
		while (true) {
			const { done, value } = await owner.wait(() => reader.read());
			owner.throwIfStopped();
			if (done) { eof = true; break; }
			if (value.byteLength > bytes.byteLength - size) throw new AdminServiceError(502, 'Playground upstream control response exceeds the limit');
			bytes.set(value, size);
			size += value.byteLength;
		}
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
	} catch (error) {
		if (error instanceof RequestExecutionStoppedError || error instanceof AdminServiceError) throw error;
		throw new AdminServiceError(502, 'Playground upstream returned invalid JSON');
	} finally {
		if (!eof) void reader.cancel('playground_control_read_stopped').catch(() => undefined);
		reader.releaseLock();
	}
}

/** Remove the abort listener on both timer and cancellation paths. */
export async function waitPlaygroundPoll(owner: RequestDeadline): Promise<void> {
	owner.throwIfStopped();
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => { clearTimeout(timer); owner.signal.removeEventListener('abort', onAbort); };
		const onAbort = () => { cleanup(); reject(owner.signal.reason); };
		const timer = setTimeout(() => { cleanup(); resolve(); }, 1000);
		owner.signal.addEventListener('abort', onAbort, { once: true });
		if (owner.signal.aborted) onAbort();
	});
	owner.throwIfStopped();
}
