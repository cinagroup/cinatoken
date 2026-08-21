/**
 * 用户路由：`/user/gateway-keys` — 自助管理自己的网关调用密钥（`sk-`）。
 */
import { Hono } from 'hono';
import { createKey } from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';

export const userGatewayKeysRoutes = new Hono<UserEnv>();

userGatewayKeysRoutes.get('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const keys = await repositories.apiKeys.listKeysByUserId(principal.userId);
	return c.json({
		success: true,
		data: keys.map((row) => ({
			id: row.id,
			key: `${row.key.slice(0, 8)}…${row.key.slice(-4)}`,
			name: row.name,
			status: row.status,
			lastUsedAt: row.last_used_at,
			createdAt: row.created_at,
		})),
	});
});

userGatewayKeysRoutes.post('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
	const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 128) : 'portal key';
	const created = await createKey(repositories, {
		user_id: principal.userId,
		name,
		provision_reason: 'User portal self-service key',
		actor_id: `portal:${principal.userId}`,
	});
	return c.json({ success: true, data: created });
});

userGatewayKeysRoutes.delete('/:id', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const id = c.req.param('id');
	const row = await repositories.apiKeys.getApiKeyById(id);
	if (!row || row.user_id !== principal.userId) {
		return c.json({ success: false, message: 'Not found' }, 404);
	}
	await repositories.apiKeys.revokeApiKey(id);
	return c.json({ success: true });
});
