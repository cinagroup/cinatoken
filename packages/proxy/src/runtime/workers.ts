import {
	assertSharedKeyEncryptionSecret,
	createEncryptedProvidersRepository,
	createEnvironmentProviderKeysRepository,
	createEncryptedSharedKeysRepository,
	createEncryptedByokKeysRepository,
	DEEPSEEK_OFFICIAL_ENVIRONMENT_SECRET_POLICY,
	createWorkerStorageContext,
	isGatewayMaintenanceMode,
	resolveWorkerDatabaseConfig,
	type StorageContext,
} from '@octafuse/core';
import type { Context } from 'hono';
import { createProxyApp, type Env } from '../app';

export async function resolveWorkerStorageFromBindings(
	bindings: Env['Bindings']
): Promise<StorageContext> {
	const config = resolveWorkerDatabaseConfig(bindings);
	const storage = await createWorkerStorageContext(config);
	const secret = assertSharedKeyEncryptionSecret(bindings.SHARED_KEY_ENCRYPTION_SECRET);
	return {
		...storage,
		repositories: {
			...storage.repositories,
			sharedKeys: createEncryptedSharedKeysRepository(storage.repositories.sharedKeys, secret),
			byokKeys: createEncryptedByokKeysRepository(storage.repositories.byokKeys, secret),
			providers: createEnvironmentProviderKeysRepository(
				createEncryptedProvidersRepository(storage.repositories.providers, secret),
				{
					policies: [DEEPSEEK_OFFICIAL_ENVIRONMENT_SECRET_POLICY],
					secrets: { DEEPSEEK_API_KEY: bindings.DEEPSEEK_API_KEY },
				},
			),
		},
	};
}

async function resolveWorkersStorage(context: Context<Env>): Promise<StorageContext> {
	return await resolveWorkerStorageFromBindings(context.env);
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
