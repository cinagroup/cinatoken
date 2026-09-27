import type { D1Database } from '@cloudflare/workers-types';
import type {
	ChainJobMessage,
	GatewayRepositories,
	HyperdriveBinding,
	StorageContext,
	WorkspaceContextProjection,
} from '@octafuse/core';
import type { UserPrincipal } from '@/lib/user-auth';

/** 用户门户 Hono 应用：Cloudflare 绑定与请求级变量。 */
export type UserBindings = {
	DB?: D1Database;
	HYPERDRIVE?: HyperdriveBinding;
	ASSETS?: unknown;
	CINAAUTH_AUTH_SERVICE?: Fetcher;
	CINAAUTH_ISSUER?: string;
	CINAAUTH_ACCOUNT_ORIGIN?: string;
	CINATOKEN_APP_ORIGIN?: string;
	CINATOKEN_OIDC_CLIENT_ID?: string;
	CINATOKEN_OIDC_CLIENT_SECRET?: string;
	CINATOKEN_OIDC_BRIDGE_SECRET?: string;
	CINATOKEN_OIDC_TRANSACTION_SECRET?: string;
	CINATOKEN_IDENTITY_EVENTS_SECRET?: string;
	/** Explicit comma-separated CinaAuth roles allowed organization-wide billing authority. */
	CINAAUTH_ORGANIZATION_ADMIN_ROLES?: string;
	SHARED_KEY_ENCRYPTION_SECRET?: string;
	/** Review-only seller statistics reader; exact opt-in, default off. */
	SHARED_KEY_CREDITED_USAGE_READER?: string;
	/** Seller-only signed statistics route; exact review opt-in, default off. */
	SIGNED_SELLER_STATS_READER?: string;
	/** Review-only independent claim issuer, backed by an authority outside ordinary Gateway SQL. */
	STATS_CLAIM_ISSUER?: Fetcher;
	/** Review-only dedicated direct `cinatoken_gateway_stats_reader` LOGIN. */
	STATS_READER_HYPERDRIVE?: HyperdriveBinding;
	DEEPSEEK_API_KEY?: string;
	CHAIN_JOBS?: Queue<ChainJobMessage>;
	/** Node / 自托管数据库使用 `DATABASE_URL`；Cloudflare Postgres 只使用 `HYPERDRIVE`。 */
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
		/** Re-authorized on every user API request; browser cookies are preference only. */
		workspaceContext: WorkspaceContextProjection;
	};
};
