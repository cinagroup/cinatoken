import {
	createMySqlStorageContext,
	createPostgresStorageContext,
	resolveNodeDatabaseConfig,
} from '@octafuse/core';
import { pathToFileURL } from 'node:url';
import {
	resolveProviderAttemptRetentionConfig,
	runProviderAttemptRetention,
} from '../../../packages/proxy/src/services/provider-attempt-retention';

export async function runProviderAttemptRetentionOnce(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const database = resolveNodeDatabaseConfig(environment);
	const storage = database.driver === 'mysql'
		? await createMySqlStorageContext(database.connectionString)
		: await createPostgresStorageContext(database.connectionString, { max: 1, prepare: true });
	try {
		const result = await runProviderAttemptRetention({
			repository: storage.repositories.requestLogs,
			nowMs: Date.now(),
			config: resolveProviderAttemptRetentionConfig(environment),
		});
		console.log(JSON.stringify({
			event: 'gateway.provider_attempt_retention.completed',
			runtime: 'node',
			driver: database.driver,
			...result,
		}));
	} finally {
		if (storage.client.driver === 'postgres') {
			await storage.client.raw.end({ timeout: 5 });
		} else if (storage.client.driver === 'mysql') {
			await storage.client.raw.end();
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runProviderAttemptRetentionOnce().catch((error) => {
		console.error(JSON.stringify({
			event: 'gateway.provider_attempt_retention.failed',
			runtime: 'node',
			errorName: error instanceof Error ? error.name : 'UnknownError',
		}));
		process.exitCode = 1;
	});
}
