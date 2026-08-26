import type { StorageContext } from '@octafuse/core/storage/context';
import {
	assertSharedKeyEncryptionSecret,
	createEncryptedSharedKeysRepository,
} from '@octafuse/core';
import { createWorkerStorageContext } from '@octafuse/core/storage/context';
import {
	resolveNodeDatabaseConfig,
	resolveWorkerDatabaseConfig,
} from '@octafuse/core/storage/runtime-database-config';
import type { AdminBindings } from '@/lib/admin-env';

let nodeStoragePromise: Promise<StorageContext> | null = null;
type RuntimeMode = 'auto' | 'cloudflare' | 'node';

/** Node：`DATABASE_URL` 与 `DATABASE_DRIVER` 与 bindings 合并（与 proxy 一致）。 */
function getNodeDatabaseEnv(bindings?: AdminBindings): {
	DATABASE_DRIVER?: string;
	DATABASE_URL?: string;
} {
	const dbUrl = bindings?.DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || undefined;
	const driver = bindings?.DATABASE_DRIVER?.trim() || process.env.DATABASE_DRIVER?.trim() || undefined;
	return {
		DATABASE_URL: dbUrl,
		DATABASE_DRIVER: driver,
	};
}

function protectSharedKeys(storage: StorageContext, bindings?: AdminBindings): StorageContext {
	const secret = assertSharedKeyEncryptionSecret(
		bindings?.SHARED_KEY_ENCRYPTION_SECRET ?? process.env.SHARED_KEY_ENCRYPTION_SECRET,
	);
	return {
		...storage,
		repositories: {
			...storage.repositories,
			sharedKeys: createEncryptedSharedKeysRepository(storage.repositories.sharedKeys, secret),
		},
	};
}

export async function resolveAdminStorageContext(
	bindings?: AdminBindings,
	mode: RuntimeMode = 'auto'
): Promise<StorageContext> {
	if (bindings?.STORAGE_CONTEXT) {
		return bindings.STORAGE_CONTEXT;
	}

	const isCloudflareMode =
		mode === 'cloudflare' ||
		(mode === 'auto' && Boolean(bindings?.DB || bindings?.HYPERDRIVE || bindings?.ASSETS));
	if (isCloudflareMode) {
		const cfg = resolveWorkerDatabaseConfig({
			DB: bindings?.DB,
			HYPERDRIVE: bindings?.HYPERDRIVE,
			DATABASE_DRIVER: bindings?.DATABASE_DRIVER,
		});
		return protectSharedKeys(await createWorkerStorageContext(cfg), bindings);
	}

	const nodeEnv = getNodeDatabaseEnv(bindings);
	const nodeCfg = resolveNodeDatabaseConfig(nodeEnv);

	if (nodeStoragePromise === null) {
		const nodeContext = await import('@octafuse/core/storage/context');
		const p =
			nodeCfg.driver === 'mysql'
				? nodeContext.createMySqlStorageContext(nodeCfg.connectionString)
				: nodeContext.createPostgresStorageContext(nodeCfg.connectionString);
		nodeStoragePromise = p.catch((err) => {
			nodeStoragePromise = null;
			throw err;
		});
	}
	return protectSharedKeys(await nodeStoragePromise, bindings);
}
