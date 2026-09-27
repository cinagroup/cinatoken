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
	withUnpublishedPostgresClient,
	type StorageContext,
} from '@octafuse/core';
import type { Context } from 'hono';
import { createProxyApp, type Env, type ProxyAppOptions } from '../app';

export async function resolveWorkerStorageFromBindings(
	bindings: Env['Bindings']
): Promise<StorageContext> {
	const config = resolveWorkerDatabaseConfig(bindings);
	const secret = assertSharedKeyEncryptionSecret(bindings.SHARED_KEY_ENCRYPTION_SECRET);
	const storage = await createWorkerStorageContext(config);
	const decorate = (): StorageContext => ({
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
	});
	return storage.client.driver === 'postgres'
		? withUnpublishedPostgresClient(storage.client.raw, 'worker_decoration', decorate)
		: decorate();
}

async function resolveWorkersStorage(context: Context<Env>): Promise<StorageContext> {
	return await resolveWorkerStorageFromBindings(context.env);
}

/** Only a client which was never handed to auth/planning/accounting may be closed here. */
export async function disposeUnusedWorkerStorage(storage: StorageContext): Promise<void> {
	if (storage.client.driver === 'd1') return;
	if (storage.client.driver !== 'postgres') throw new Error('Unexpected Workers storage driver');
	await storage.client.raw.end({ timeout: 1 });
}

/** Reuse the real storage/secret/maintenance contract in an explicitly composed runtime. */
export type WorkerAppOptions = Pick<ProxyAppOptions, 'imageFetch' | 'imageUsageRecovery'
	| 'postgresImageRecovery' | 'httpCapacity'>;

export function createWorkerApp(options?: WorkerAppOptions) {
	return createProxyApp(resolveWorkersStorage, {
		disposeUnusedStorage: disposeUnusedWorkerStorage,
		imageFetch: options?.imageFetch,
		// Server composition only; neither bindings nor request input enable recovery.
		imageUsageRecovery: options?.imageUsageRecovery,
		postgresImageRecovery: options?.postgresImageRecovery,
		// Explicit server composition only. No default weights or binding/header activation.
		httpCapacity: options?.httpCapacity,
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
			const config = resolveWorkerDatabaseConfig(c.env);
			if (options?.postgresImageRecovery && config.driver !== 'postgres') {
				throw new TypeError('PostgreSQL Images recovery requires a PostgreSQL Worker database driver');
			}
			assertSharedKeyEncryptionSecret(c.env.SHARED_KEY_ENCRYPTION_SECRET);
			return next();
		},
	});
}
