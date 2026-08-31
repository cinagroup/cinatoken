/**
 * Admin Worker 的原生 WebSocket 入口。
 * OpenNext 的 Next Server Function 只转发 HTTP 状态和 body，会丢失 Response.webSocket，
 * 因此实时调试请求必须在最外层 Worker 中直接交给 Hono。
 */
import { authenticateAdminRequest } from './auth';
import { handleGatewayApiError } from './api-error';
import type { AdminBindings } from './admin-env';
import { getAdminApp } from './admin-app';
import { resolveAdminStorageContext } from './storage-context';
import { verifyCinaAuthConsolePrincipal } from './cinaauth/principal';
import { rejectRateLimitedAdminAuth } from './admin-auth-rate-limit';

function rewriteToInternalAdminPath(request: Request): Request {
	const url = new URL(request.url);
	const prefix = '/api/admin';
	url.pathname = '/admin' + url.pathname.slice(prefix.length);
	return new Request(url, request);
}

/** 处理调试台原生 DashScope WebSocket，保留 Cloudflare 的 `webSocket` 响应对象。 */
export async function handleAdminRealtimeUpgrade(
	request: Request,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	try {
		const runtimeBindings: AdminBindings = {
			DB: env.DB,
			HYPERDRIVE: env.HYPERDRIVE,
			ASSETS: env.ASSETS,
			CINAAUTH_AUTH_SERVICE: env.CINAAUTH_AUTH_SERVICE,
			CINAAUTH_ISSUER: env.CINAAUTH_ISSUER,
			CINAAUTH_ACCOUNT_ORIGIN: env.CINAAUTH_ACCOUNT_ORIGIN,
			CINATOKEN_APP_ORIGIN: env.CINATOKEN_APP_ORIGIN,
			CINATOKEN_OIDC_CLIENT_ID: env.CINATOKEN_OIDC_CLIENT_ID,
			CINATOKEN_REQUIRED_ROLES: env.CINATOKEN_REQUIRED_ROLES,
			CINATOKEN_OIDC_CLIENT_SECRET: env.CINATOKEN_OIDC_CLIENT_SECRET,
			CINATOKEN_OIDC_BRIDGE_SECRET: env.CINATOKEN_OIDC_BRIDGE_SECRET,
			CINATOKEN_OIDC_TRANSACTION_SECRET: env.CINATOKEN_OIDC_TRANSACTION_SECRET,
			CINATOKEN_IDENTITY_EVENTS_SECRET: env.CINATOKEN_IDENTITY_EVENTS_SECRET,
			CINAAUTH_ORGANIZATION_ADMIN_ROLES: env.CINAAUTH_ORGANIZATION_ADMIN_ROLES,
			SHARED_KEY_ENCRYPTION_SECRET: env.SHARED_KEY_ENCRYPTION_SECRET,
			DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
			AUTH_RATE_LIMITER: env.AUTH_RATE_LIMITER,
			DATABASE_DRIVER: env.DATABASE_DRIVER,
		};
		const storage = await resolveAdminStorageContext(runtimeBindings, 'cloudflare');
		const authenticated = await authenticateAdminRequest(request, storage.repositories);
		const principal = authenticated
			? await verifyCinaAuthConsolePrincipal(request, authenticated, runtimeBindings)
			: null;
		if (!principal) {
			const rateLimited = await rejectRateLimitedAdminAuth(request, runtimeBindings);
			if (rateLimited) return rateLimited;
			return Response.json({ success: false, message: 'Unauthorized' }, { status: 401 });
		}

		const appBindings: AdminBindings = {
			...runtimeBindings,
			STORAGE_CONTEXT: storage,
			ADMIN_PRINCIPAL: principal,
		};
		return getAdminApp().fetch(rewriteToInternalAdminPath(request), appBindings, ctx);
	} catch (error) {
		return handleGatewayApiError({ route: 'admin.realtime.worker', error });
	}
}
