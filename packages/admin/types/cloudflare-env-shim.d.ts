/**
 * Minimal Cloudflare `Env` typings when `cloudflare-env.d.ts` is absent
 * (e.g. `npm run build:docker` / Docker image build without `wrangler types`).
 * After `npm run cf-typegen`, Wrangler-generated `cloudflare-env.d.ts` augments/merges with this.
 */
/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		HYPERDRIVE?: import('@octafuse/core').HyperdriveBinding;
		ASSETS: Fetcher;
		CINAAUTH_AUTH_SERVICE: Fetcher;
		CINAAUTH_ISSUER: string;
		CINAAUTH_ACCOUNT_ORIGIN: string;
		CINATOKEN_APP_ORIGIN: string;
		CINATOKEN_OIDC_CLIENT_ID: string;
		CINATOKEN_REQUIRED_ROLES: string;
		CINATOKEN_OIDC_CLIENT_SECRET: string;
		CINATOKEN_OIDC_BRIDGE_SECRET: string;
		CINATOKEN_OIDC_TRANSACTION_SECRET: string;
		SHARED_KEY_ENCRYPTION_SECRET: string;
		CHAIN_JOBS: Queue<import('@octafuse/core').ChainJobMessage>;
		ADMIN_USERNAME?: string;
		ADMIN_PASSWORD?: string;
		ADMIN_COOKIE_SECURE?: string;
		DATABASE_URL?: string;
		DATABASE_DRIVER?: string;
		CINATOKEN_MAINTENANCE_MODE?: string;
	}
}

interface CloudflareEnv extends Cloudflare.Env {}
