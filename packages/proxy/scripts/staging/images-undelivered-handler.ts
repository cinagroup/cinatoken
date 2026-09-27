/// <reference path="./images-env.d.ts" />
import { createImagesFencingGateway } from './images-fencing-handler';
import { IMAGE_STORAGE_FAULT_HEADER, parseImageStorageFault } from './images-storage-fault-contract';

export const UNDELIVERED_IMAGE_GATE_MS = 10_000;

/** Staging fault injection, NOT a production retry/refund or response policy. */
export function withUndeliveredImageSuccess(handler: Pick<ReturnType<typeof createImagesFencingGateway>, 'fetch'>) {
	return {
		fetch(request, bindings, context) {
			const probe = parseImageStorageFault(request.headers.get(IMAGE_STORAGE_FAULT_HEADER) ?? '');
			if (request.method !== 'POST' || !/^\/v1\/images\/(generations|edits)$/.test(new URL(request.url).pathname)
				|| (probe?.mode !== 'before-abort' && probe?.mode !== 'after-abort')) {
				return handler.fetch(request, bindings, context);
			}
			const delivery = Promise.resolve().then(async () => {
				// The original gateway retains all admission, tenant-owned probe, native
				// abort capability, durable snapshot and accounting checks.
				const response = await handler.fetch(request, bindings, context);
				if (response.status !== 200) return response;
				// Never expose this success Response, including after a missed/shim abort.
				// Real ctx.abort terminates this invocation while the bounded gate waits.
				await new Promise<void>(resolve => setTimeout(resolve, UNDELIVERED_IMAGE_GATE_MS));
				if (response.body) context.waitUntil(response.body.cancel());
				return new Response('C02_STAGING_DELIVERY_GATE_EXPIRED', {
					status: 503, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
				});
			});
			// Keep native receivers and register before dispatch; no mutable global
			// request data, body draining, synthetic financial writes or client timer.
			context.waitUntil(delivery.then(() => undefined));
			return delivery;
		},
	} satisfies ExportedHandler<ImagesStagingEnv>;
}

export function createImagesUndeliveredGateway(transport: typeof fetch) {
	const handler = createImagesFencingGateway(transport);
	return { ...handler, ...withUndeliveredImageSuccess(handler) } satisfies ExportedHandler<ImagesStagingEnv>;
}
