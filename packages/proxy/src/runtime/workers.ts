import {
	assertSharedKeyEncryptionSecret,
	createEncryptedProvidersRepository,
	createEnvironmentProviderKeysRepository,
	createEncryptedSharedKeysRepository,
	DEEPSEEK_OFFICIAL_ENVIRONMENT_SECRET_POLICY,
	createWorkerStorageContext,
	isGatewayMaintenanceMode,
	resolveWorkerDatabaseConfig,
	type StorageContext,
} from '@octafuse/core';
import type { Context } from 'hono';
import { createProxyApp, type Env } from '../app';

async function resolveWorkersStorage(context: Context<Env>): Promise<StorageContext> {
	const config = resolveWorkerDatabaseConfig(context.env);
	const storage = await createWorkerStorageContext(config);
	const secret = assertSharedKeyEncryptionSecret(context.env.SHARED_KEY_ENCRYPTION_SECRET);
	return {
		...storage,
		repositories: {
			...storage.repositories,
			sharedKeys: createEncryptedSharedKeysRepository(storage.repositories.sharedKeys, secret),
			providers: createEnvironmentProviderKeysRepository(
				createEncryptedProvidersRepository(storage.repositories.providers, secret),
				{
					policies: [DEEPSEEK_OFFICIAL_ENVIRONMENT_SECRET_POLICY],
					secrets: { DEEPSEEK_API_KEY: context.env.DEEPSEEK_API_KEY },
				},
			),
		},
	};
}

export const workerApp = createProxyApp(resolveWorkersStorage, {
	beforeAll: async (c, next) => {
		if (isGatewayMaintenanceMode(c.env.CINATOKEN_MAINTENANCE_MODE)) {
			return c.json({
				error: {
					message: 'CinaToken is temporarily unavailable for scheduled maintenance.',
					type: 'maintenance_mode',
				},
			}, 503, {
				'Cache-Control': 'no-store',
				'Retry-After': '60',
			});
		}
		resolveWorkerDatabaseConfig(c.env);
		assertSharedKeyEncryptionSecret(c.env.SHARED_KEY_ENCRYPTION_SECRET);
		return next();
	},
});
