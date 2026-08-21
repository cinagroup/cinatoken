import type { D1Database } from '@cloudflare/workers-types';
import type { GatewayRepositories, StorageContext } from '@octafuse/core';
import type { UserPrincipal } from '@/lib/user-auth';

/** 用户门户 Hono 应用：Cloudflare 绑定与请求级变量。 */
export type UserBindings = {
	DB?: D1Database;
	ASSETS?: unknown;
	CINAAUTH_AUTH_SERVICE?: Fetcher;
	CINAAUTH_ISSUER?: string;
	CINAAUTH_ACCOUNT_ORIGIN?: string;
	CINATOKEN_APP_ORIGIN?: string;
	CINATOKEN_OIDC_CLIENT_ID?: string;
	CINATOKEN_OIDC_CLIENT_SECRET?: string;
	CINATOKEN_OIDC_BRIDGE_SECRET?: string;
	CINATOKEN_OIDC_TRANSACTION_SECRET?: string;
	/** Node / 自托管 Postgres：与 `@octafuse/proxy` 一致，使用 `DATABASE_URL`。 */
	DATABASE_URL?: string;
	DATABASE_DRIVER?: string;
	STORAGE_CONTEXT?: StorageContext;
	USER_PRINCIPAL?: UserPrincipal;
};

export type UserEnv = {
	Bindings: UserBindings;
	Variables: {
		repositories: GatewayRepositories;
		principal: UserPrincipal;
	};
};
