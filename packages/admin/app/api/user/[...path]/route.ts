/**
 * 用户门户 API：`/api/user/*` → 内部重写为 `/user/*` 后交给 Hono 用户子应用。
 * 仅接受 `user_session` Cookie 会话（与管理台完全隔离），无 Bearer 通道。
 */
import type { UserBindings } from '@/lib/user-env';
import { getUserApp } from '@/lib/user-app';
import { handleGatewayApiError } from '@/lib/api-error';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { authenticateUserRequest } from '@/lib/user-auth';

export const dynamic = 'force-dynamic';

function rewriteToInternalUserPath(request: Request): Request {
	const u = new URL(request.url);
	const prefix = '/api/user';
	if (!u.pathname.startsWith(prefix)) {
		return request;
	}
	const rest = u.pathname.slice(prefix.length);
	u.pathname = '/user' + (rest === '' ? '' : rest);
	return new Request(u.toString(), request);
}

async function handle(request: Request): Promise<Response> {
	try {
		const { bindings: runtimeBindings, storage, ctx } = await resolveAdminRequestRuntime(request);
		const { repositories } = storage;
		const principal = await authenticateUserRequest(request, repositories);
		if (!principal) {
			return Response.json({ success: false, message: 'Unauthorized' }, { status: 401 });
		}

		const internalReq = rewriteToInternalUserPath(request);
		const app = getUserApp();
		const appBindings: UserBindings = {
			...runtimeBindings,
			STORAGE_CONTEXT: storage,
			USER_PRINCIPAL: principal,
		};
		if (ctx) {
			return app.fetch(internalReq, appBindings, ctx);
		}
		return app.fetch(internalReq, appBindings);
	} catch (error) {
		return handleGatewayApiError({ route: 'user.catch-all', error });
	}
}

export const GET = (request: Request) => handle(request);
export const POST = (request: Request) => handle(request);
export const PUT = (request: Request) => handle(request);
export const PATCH = (request: Request) => handle(request);
export const DELETE = (request: Request) => handle(request);
export const OPTIONS = (request: Request) => handle(request);
