import type { GatewayBindings } from './app';
import { runWorkerProviderAttemptRetention } from './runtime/provider-attempt-retention-worker';
import { handleWorkerBatchQueue } from './runtime/batch-queue';
import { resolveWorkerStorageFromBindings, workerApp } from './runtime/workers';

export type { Env } from './app';

export const workerHandler = {
	fetch(request, environment, context) {
		return workerApp.fetch(request, environment, context);
	},
	scheduled(controller, environment, context) {
		context.waitUntil(runWorkerProviderAttemptRetention(controller, environment));
	},
	queue(batch, environment) {
		return handleWorkerBatchQueue(batch, environment, {
			resolveBatchesRepository: async () =>
				(await resolveWorkerStorageFromBindings(environment)).repositories.batches,
		});
	},
} satisfies ExportedHandler<GatewayBindings>;

export default workerHandler;
