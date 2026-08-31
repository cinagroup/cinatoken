import type { D1Database } from '@cloudflare/workers-types';
import type {
	ChainJobMessage,
	GatewayRepositories,
	HyperdriveBinding,
	StorageContext,
} from '@octafuse/core';
import type { AdminPrincipal } from '@/lib/admin-principal';

/** Admin Hono 应用：Cloudflare 绑定与请求级变量。 */
export type AdminBindings = {
	DB?: D1Database;
	HYPERDRIVE?: HyperdriveBinding;
	ASSETS?: unknown;
	CINAAUTH_AUTH_SERVICE?: Fetcher;
	CINAAUTH_ISSUER?: string;
	CINAAUTH_ACCOUNT_ORIGIN?: string;
	CINATOKEN_APP_ORIGIN?: string;
	CINATOKEN_OIDC_CLIENT_ID?: string;
	CINATOKEN_REQUIRED_ROLES?: string;
	CINATOKEN_OIDC_CLIENT_SECRET?: string;
	CINATOKEN_OIDC_BRIDGE_SECRET?: string;
	CINATOKEN_OIDC_TRANSACTION_SECRET?: string;
	CINATOKEN_IDENTITY_EVENTS_SECRET?: string;
	CINAAUTH_ORGANIZATION_ADMIN_ROLES?: string;
	SHARED_KEY_ENCRYPTION_SECRET?: string;
	CHAIN_JOBS?: Queue<ChainJobMessage>;
	/** Workers rate-limiting binding（wrangler.base.jsonc ratelimits）。认证失败限速；未注入时跳过。 */
	AUTH_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
	/** 旧部署绑定名兼容；新部署统一使用 `AUTH_RATE_LIMITER`。 */
	RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
	/** Node / 自托管数据库使用 `DATABASE_URL`；Cloudflare Postgres 只使用 `HYPERDRIVE`。 */
	DATABASE_URL?: string;
	/** Node 下省略视为 `postgres`；Cloudflare 下省略保持 D1，显式 `postgres` 才切 Hyperdrive。 */
	DATABASE_DRIVER?: string;
	STORAGE_CONTEXT?: StorageContext;
	ADMIN_PRINCIPAL?: AdminPrincipal;
};

export type AdminEnv = {
	Bindings: AdminBindings;
	Variables: {
		repositories: GatewayRepositories;
		principal: AdminPrincipal;
	};
};
