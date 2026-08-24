import {
	assertSharedKeyEncryptionSecret,
	createD1StorageContext,
	createEncryptedSharedKeysRepository,
	resolveWorkerDatabaseConfig,
	type StorageContext,
} from '@octafuse/core';
import type { Context } from 'hono';
import { createProxyApp, type Env } from '../app';

async function resolveWorkersStorage(context: Context<Env>): Promise<StorageContext> {
	const config = resolveWorkerDatabaseConfig(context.env);
	const storage = createD1StorageContext(config.db);
	const secret = assertSharedKeyEncryptionSecret(context.env.SHARED_KEY_ENCRYPTION_SECRET);
	return {
		...storage,
		repositories: {
			...storage.repositories,
			sharedKeys: createEncryptedSharedKeysRepository(storage.repositories.sharedKeys, secret),
		},
	};
}

export const workerApp = createProxyApp(resolveWorkersStorage, {
	beforeAll: (c, next) => {
		resolveWorkerDatabaseConfig(c.env);
		assertSharedKeyEncryptionSecret(c.env.SHARED_KEY_ENCRYPTION_SECRET);
		return next();
	},
});
