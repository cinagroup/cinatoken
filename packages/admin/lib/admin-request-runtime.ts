import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { StorageContext } from '@octafuse/core';
import type { AdminBindings } from '@/lib/admin-env';
import { getCloudflareEnv } from '@/lib/cloudflare';
import { resolveAdminStorageContext } from '@/lib/storage-context';

interface RequestWithCloudflare extends Request {
	ctx?: { cloudflare?: { env?: CloudflareEnv } };
	env?: CloudflareEnv;
}

export async function resolveAdminRequestRuntime(request?: Request): Promise<{
	bindings: AdminBindings;
	storage: StorageContext;
	ctx?: ExecutionContext;
}> {
	let env: CloudflareEnv | undefined;
	let ctx: ExecutionContext | undefined;
	let hasCloudflareContext = false;
	try {
		const cf = getCloudflareContext();
		env = cf.env as CloudflareEnv;
		ctx = cf.ctx;
		hasCloudflareContext = true;
	} catch {
		env = getCloudflareEnv(request);
	}

	const requestEnv = request as RequestWithCloudflare | undefined;
	const cloudflareRuntime = hasCloudflareContext || Boolean(
		env?.DB ||
			env?.HYPERDRIVE ||
			env?.ASSETS ||
			requestEnv?.ctx?.cloudflare?.env ||
			requestEnv?.env?.DB ||
			requestEnv?.env?.HYPERDRIVE ||
			requestEnv?.env?.ASSETS
	);

	const bindings: AdminBindings = {
		DB: env?.DB,
		HYPERDRIVE: env?.HYPERDRIVE,
		ASSETS: env?.ASSETS,
		CINAAUTH_AUTH_SERVICE: env?.CINAAUTH_AUTH_SERVICE,
		CINAAUTH_ISSUER: env?.CINAAUTH_ISSUER,
		CINAAUTH_ACCOUNT_ORIGIN: env?.CINAAUTH_ACCOUNT_ORIGIN,
		CINATOKEN_APP_ORIGIN: env?.CINATOKEN_APP_ORIGIN,
		CINATOKEN_OIDC_CLIENT_ID: env?.CINATOKEN_OIDC_CLIENT_ID,
		CINATOKEN_REQUIRED_ROLES: env?.CINATOKEN_REQUIRED_ROLES,
		CINATOKEN_OIDC_CLIENT_SECRET: env?.CINATOKEN_OIDC_CLIENT_SECRET,
		CINATOKEN_OIDC_BRIDGE_SECRET: env?.CINATOKEN_OIDC_BRIDGE_SECRET,
		CINATOKEN_OIDC_TRANSACTION_SECRET: env?.CINATOKEN_OIDC_TRANSACTION_SECRET,
		SHARED_KEY_ENCRYPTION_SECRET:
			env?.SHARED_KEY_ENCRYPTION_SECRET ?? process.env.SHARED_KEY_ENCRYPTION_SECRET,
		CHAIN_JOBS: env?.CHAIN_JOBS,
		DATABASE_URL: cloudflareRuntime ? undefined : process.env.DATABASE_URL,
		DATABASE_DRIVER: cloudflareRuntime
			? (env as { DATABASE_DRIVER?: string } | undefined)?.DATABASE_DRIVER
			: process.env.DATABASE_DRIVER,
	};
	const storage = await resolveAdminStorageContext(bindings, cloudflareRuntime ? 'cloudflare' : 'node');
	return { bindings, storage, ctx };
}
