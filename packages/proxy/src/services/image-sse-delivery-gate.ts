import { GatewayErrorCode } from './gateway-error-codes';

const done = new TextEncoder().encode('data: [DONE]\n\n');
/** Internal validated driver frames only, never arbitrary provider wire chunks. */
export function gateImageSseDelivery(response: Response, accepted: Promise<void>, requestId: string): Response {
	if (!response.body) throw new Error('Image SSE delivery requires a response body');
	// Observe rejection immediately, including when the client never reads DONE.
	const confirmation = accepted.then(() => true, () => false);
	const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
	let closed = false;
	let stopWaiting: (() => void) | undefined;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (closed) return;
				if (next.done) { closed = true; reader.releaseLock(); controller.close(); return; }
				const chunk = next.value;
				if (chunk.length === done.length && chunk.every((byte, index) => byte === done[index])) {
					// A bounded delivery wait is not a cancellation of the financial event.
					let timer: ReturnType<typeof setTimeout> | undefined;
					const timeout = new Promise<boolean>(resolve => {
						stopWaiting = () => resolve(false);
						timer = setTimeout(stopWaiting, 15_000);
					});
					let confirmed: boolean;
					try { confirmed = await Promise.race([confirmation, timeout]); }
					finally { clearTimeout(timer); stopWaiting = undefined; }
					if (closed) return;
					if (!confirmed) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
						type: 'error', error: { code: GatewayErrorCode.imageSettlementUnconfirmed,
							message: 'Image settlement persistence is unconfirmed. Do not automatically retry.',
							metadata: { request_id: requestId, outcome_unknown: true, retry_safe: false } },
					})}\n\n`));
				}
				controller.enqueue(chunk);
			} catch (error) {
				if (closed) return;
				closed = true;
				void reader.cancel(error).catch(() => undefined).finally(() => reader.releaseLock());
				controller.error(error);
			}
		},
		cancel(reason) {
			closed = true;
			stopWaiting?.();
			// Never wait for a database write or revoke accepted accounting here.
			void reader.cancel(reason).catch(() => undefined).finally(() => reader.releaseLock());
		},
	}, { highWaterMark: 0 });
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
