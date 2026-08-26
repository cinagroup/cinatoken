/**
 * Cloudflare Worker 外层入口：实时调试 WS 必须绕过 OpenNext Server Function，
 * 其余请求继续交给 OpenNext 生成的 Next Worker。
 */
import nextWorker from './.open-next/worker.js';
import { isGatewayMaintenanceMode } from '@octafuse/core';
import { handleAdminRealtimeUpgrade } from './lib/admin-realtime-worker';

const PLAYGROUND_REALTIME_PATH = '/api/admin/playground/realtime';

export default {
	async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
		if (isGatewayMaintenanceMode(env.CINATOKEN_MAINTENANCE_MODE)) {
			return Response.json({
				success: false,
				message: 'CinaToken is temporarily unavailable for scheduled maintenance.',
			}, {
				status: 503,
				headers: {
					'Cache-Control': 'no-store',
					'Retry-After': '60',
				},
			});
		}
		const url = new URL(request.url);
		if (
			request.method === 'GET' &&
			url.pathname === PLAYGROUND_REALTIME_PATH &&
			request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
		) {
			return handleAdminRealtimeUpgrade(request, env, ctx);
		}
		return nextWorker.fetch(request, env, ctx);
	},
};
