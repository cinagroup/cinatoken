import type { GatewayBindings } from '../app';
import { runWorkerProviderAttemptRetention } from './provider-attempt-retention-worker';
import { runWorkerSharedKeyUsageRepair } from './shared-key-usage-repair-worker';
import { handleWorkerBatchQueue } from './batch-queue';
import { createWorkerApp, resolveWorkerStorageFromBindings, type WorkerAppOptions } from './workers';

/** Compose one real app and the same event handlers for each Worker entry point. */
export function createWorkerHandler(options?: WorkerAppOptions) {
	const app = createWorkerApp(options);
	return {
		fetch(request, environment, context) {
			// A disconnected caller can end the invocation before a route catches its
			// abort and registers accounting. Hold the request flow before starting it.
			// This does not drain response bodies or replace independent background
			// holds, and is still bounded by Workers' post-disconnect execution window.
			const response = Promise.resolve().then(() => app.fetch(request, environment, context));
			context.waitUntil(response.then(() => undefined));
			return response;
		},
		scheduled(controller, environment, context) {
			context.waitUntil(runWorkerProviderAttemptRetention(controller, environment));
			context.waitUntil(runWorkerSharedKeyUsageRepair(controller, environment));
		},
		queue(batch, environment) {
			return handleWorkerBatchQueue(batch, environment, {
				resolveBatchesRepository: async () =>
					(await resolveWorkerStorageFromBindings(environment)).repositories.batches,
			});
		},
	} satisfies ExportedHandler<GatewayBindings>;
}
