import {
	createWorkerStorageContext,
	resolveWorkerDatabaseConfig,
} from '@octafuse/core';
import type { GatewayBindings } from '../app';
import {
	resolveProviderAttemptRetentionConfig,
	runProviderAttemptRetention,
} from '../services/provider-attempt-retention';

export async function runWorkerProviderAttemptRetention(
	controller: Pick<ScheduledController, 'scheduledTime' | 'cron'>,
	environment: GatewayBindings,
): Promise<void> {
	const storage = await createWorkerStorageContext(resolveWorkerDatabaseConfig(environment));
	try {
		const result = await runProviderAttemptRetention({
			repository: storage.repositories.requestLogs,
			nowMs: controller.scheduledTime,
			config: resolveProviderAttemptRetentionConfig(environment),
		});
		console.log(JSON.stringify({
			event: 'gateway.provider_attempt_retention.completed',
			cron: controller.cron,
			...result,
		}));
	} catch (error) {
		console.error(JSON.stringify({
			event: 'gateway.provider_attempt_retention.failed',
			cron: controller.cron,
			errorName: error instanceof Error ? error.name : 'UnknownError',
		}));
		throw error;
	} finally {
		if (storage.client.driver === 'postgres') {
			await storage.client.raw.end({ timeout: 1 }).catch(() => undefined);
		}
	}
}
