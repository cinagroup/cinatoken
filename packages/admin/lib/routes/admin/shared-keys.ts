/**
 * 管理路由：`/admin/shared-keys` — 用户共享密钥池治理。
 * 列表脱敏；可调 seller_priority/weight、停用、删除。
 */
import { Hono } from 'hono';
import { maskProviderApiKeyForAdmin } from '@octafuse/core';
import type { AdminEnv } from '@/lib/admin-env';
import { requireAdminPrincipal } from '@/lib/middleware/admin-auth';
import { handleAdminRouteError } from './error-response';

export const adminSharedKeysRoutes = new Hono<AdminEnv>();

adminSharedKeysRoutes.use('*', requireAdminPrincipal);

adminSharedKeysRoutes.get('/', async (c) => {
	try {
		const repos = c.get('repositories');
		const status = c.req.query('status') || undefined;
		const channelType = c.req.query('channelType') || undefined;
		const rows = await repos.sharedKeys.listAllSharedKeys({ status, channelType });
		const sellerCache = new Map<string, string>();
		const data = [];
		for (const row of rows) {
			if (!sellerCache.has(row.sellerUserId)) {
				const seller = await repos.users.getById(row.sellerUserId);
				sellerCache.set(row.sellerUserId, seller?.email ?? row.sellerUserId);
			}
			const { apiKey, ...rest } = row;
			void apiKey;
			data.push({
				...rest,
				apiKeyMasked: maskProviderApiKeyForAdmin(row.apiKey),
				sellerEmail: sellerCache.get(row.sellerUserId) ?? row.sellerUserId,
			});
		}
		return c.json({ success: true, data, total: data.length });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to list shared keys');
	}
});

adminSharedKeysRoutes.patch('/:id', async (c) => {
	const body = (await c.req.json().catch(() => null)) as
		| { sellerPriority?: unknown; weight?: unknown; status?: unknown }
		| null;
	if (!body) return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	const patch: Record<string, unknown> = {};
	if (body.sellerPriority !== undefined) {
		const num = Number(body.sellerPriority);
		if (!Number.isInteger(num)) return c.json({ success: false, message: 'sellerPriority must be an integer' }, 400);
		patch.sellerPriority = num;
	}
	if (body.weight !== undefined) {
		const num = Number(body.weight);
		if (!Number.isInteger(num) || num < 1 || num > 100) {
			return c.json({ success: false, message: 'weight must be 1-100' }, 400);
		}
		patch.weight = num;
	}
	if (body.status !== undefined) {
		if (typeof body.status !== 'string' || !['active', 'paused', 'disabled'].includes(body.status)) {
			return c.json({ success: false, message: 'status must be active|paused|disabled' }, 400);
		}
		patch.status = body.status;
	}
	if (Object.keys(patch).length === 0) {
		return c.json({ success: false, message: 'Nothing to update' }, 400);
	}
	try {
		const repos = c.get('repositories');
		const updated = await repos.sharedKeys.updateSharedKey(c.req.param('id'), patch);
		if (!updated) return c.json({ success: false, message: 'Not found' }, 404);
		return c.json({ success: true, message: 'Shared key updated' });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to update shared key');
	}
});

adminSharedKeysRoutes.delete('/:id', async (c) => {
	try {
		const repos = c.get('repositories');
		const deleted = await repos.sharedKeys.deleteSharedKey(c.req.param('id'));
		if (!deleted) return c.json({ success: false, message: 'Not found' }, 404);
		return c.json({ success: true, message: 'Shared key deleted' });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to delete shared key');
	}
});
