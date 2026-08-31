/**
 * 读取 Cloudflare / OpenNext 运行时绑定（`DB`、`ASSETS`、`ADMIN_*` 等）。
 * 按优先级尝试：`getCloudflareContext` → `request.ctx` → `globalThis` → `process.env`，兼容 `next dev` 与 Pages 预览。
 */
import type { D1Database } from '@cloudflare/workers-types';
import type { HyperdriveBinding } from '@octafuse/core';
import { getCloudflareContext } from '@opennextjs/cloudflare';

interface RequestWithCloudflare extends Request {
	ctx?: {
		cloudflare?: {
			env?: CloudflareEnv;
		};
	};
	env?: CloudflareEnv;
}

interface GlobalWithCloudflare {
	ASSETS?: CloudflareEnv['ASSETS'];
	DB?: D1Database;
	HYPERDRIVE?: HyperdriveBinding;
	CINAAUTH_AUTH_SERVICE?: Fetcher;
	CINATOKEN_PROXY_SERVICE?: Fetcher;
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
	AUTH_RATE_LIMITER?: CloudflareEnv['AUTH_RATE_LIMITER'];
	DATABASE_DRIVER?: string;
	ADMIN_USERNAME?: string;
	ADMIN_PASSWORD?: string;
	ADMIN_COOKIE_SECURE?: string;
}

interface ProcessWithEnv {
	env?: CloudflareEnv & Record<string, unknown>;
}

export function getCloudflareEnv(request?: Request): CloudflareEnv | undefined {
	try {
		const cloudflareContext = getCloudflareContext();
		if (cloudflareContext?.env) {
			return cloudflareContext.env as CloudflareEnv;
		}
	} catch {
		// 本地 next dev 等场景下常不可用
	}

	if (request) {
		const requestWithCf = request as RequestWithCloudflare;
		if (requestWithCf.ctx?.cloudflare?.env) {
			return requestWithCf.ctx.cloudflare.env;
		}

		if (requestWithCf.env) {
			return requestWithCf.env;
		}
	}

	if (typeof globalThis !== 'undefined') {
		const globalEnv = globalThis as unknown as GlobalWithCloudflare;
		if (globalEnv.ASSETS || globalEnv.DB || globalEnv.HYPERDRIVE || globalEnv.CINAAUTH_AUTH_SERVICE || globalEnv.CINATOKEN_PROXY_SERVICE || globalEnv.AUTH_RATE_LIMITER) {
			return {
				ASSETS: globalEnv.ASSETS,
				DB: globalEnv.DB,
				HYPERDRIVE: globalEnv.HYPERDRIVE,
				CINAAUTH_AUTH_SERVICE: globalEnv.CINAAUTH_AUTH_SERVICE,
				CINATOKEN_PROXY_SERVICE: globalEnv.CINATOKEN_PROXY_SERVICE,
				CINAAUTH_ISSUER: globalEnv.CINAAUTH_ISSUER,
				CINAAUTH_ACCOUNT_ORIGIN: globalEnv.CINAAUTH_ACCOUNT_ORIGIN,
				CINATOKEN_APP_ORIGIN: globalEnv.CINATOKEN_APP_ORIGIN,
				CINATOKEN_OIDC_CLIENT_ID: globalEnv.CINATOKEN_OIDC_CLIENT_ID,
				CINATOKEN_REQUIRED_ROLES: globalEnv.CINATOKEN_REQUIRED_ROLES,
				CINATOKEN_OIDC_CLIENT_SECRET: globalEnv.CINATOKEN_OIDC_CLIENT_SECRET,
				CINATOKEN_OIDC_BRIDGE_SECRET: globalEnv.CINATOKEN_OIDC_BRIDGE_SECRET,
				CINATOKEN_OIDC_TRANSACTION_SECRET: globalEnv.CINATOKEN_OIDC_TRANSACTION_SECRET,
				CINATOKEN_IDENTITY_EVENTS_SECRET: globalEnv.CINATOKEN_IDENTITY_EVENTS_SECRET,
				CINAAUTH_ORGANIZATION_ADMIN_ROLES: globalEnv.CINAAUTH_ORGANIZATION_ADMIN_ROLES,
				SHARED_KEY_ENCRYPTION_SECRET: globalEnv.SHARED_KEY_ENCRYPTION_SECRET,
				AUTH_RATE_LIMITER: globalEnv.AUTH_RATE_LIMITER,
				DATABASE_DRIVER: globalEnv.DATABASE_DRIVER,
				ADMIN_USERNAME: globalEnv.ADMIN_USERNAME,
				ADMIN_PASSWORD: globalEnv.ADMIN_PASSWORD,
				ADMIN_COOKIE_SECURE: globalEnv.ADMIN_COOKIE_SECURE,
			} as CloudflareEnv;
		}
	}

	if (typeof process !== 'undefined') {
		const proc = process as unknown as ProcessWithEnv;
		if (
			proc.env?.CINAAUTH_ISSUER ||
			proc.env?.CINATOKEN_OIDC_CLIENT_ID ||
			proc.env?.ADMIN_USERNAME ||
			proc.env?.ADMIN_PASSWORD
		) {
			return proc.env as CloudflareEnv;
		}
	}

	return undefined;
}
