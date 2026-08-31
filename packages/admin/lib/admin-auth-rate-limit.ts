import type { AdminBindings } from '@/lib/admin-env';

const RETRY_AFTER_SECONDS = 60;

/**
 * 对失败的管理员认证尝试做 Workers per-colo 限速。
 *
 * 限速器属于纵深防御：绑定缺失或 Cloudflare 服务异常时保持既有 401 语义，
 * 避免限速基础设施故障把管理面整体变成 5xx。
 */
export async function rejectRateLimitedAdminAuth(
	request: Request,
	bindings: AdminBindings,
): Promise<Response | null> {
	const limiter = bindings.AUTH_RATE_LIMITER ?? bindings.RATE_LIMITER;
	if (!limiter) return null;

	try {
		const { success } = await limiter.limit({
			key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
		});
		if (success) return null;
		return Response.json(
			{ success: false, message: 'Too many failed authentication attempts' },
			{
				status: 429,
				headers: {
					'Retry-After': String(RETRY_AFTER_SECONDS),
					'Cache-Control': 'no-store',
				},
			},
		);
	} catch {
		return null;
	}
}
