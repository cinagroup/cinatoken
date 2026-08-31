/**
 * 用户路由：`/user/gateway-keys` — 自助管理自己的网关调用密钥（`sk-`）。
 */
import { Hono } from 'hono';
import {
	createKey,
	gatewayKeyLimitAmount,
	normalizeFutureKeyExpiry,
	normalizeGatewayKeyLimitMicros,
	normalizeGatewayKeyLimitReset,
} from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';

export const userGatewayKeysRoutes = new Hono<UserEnv>();

userGatewayKeysRoutes.get('/', async (c) => {
	c.header('Cache-Control', 'private, no-store');
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const workspace = c.get('workspaceContext').currentWorkspace;
	const keys = await repositories.apiKeys.listKeysByWorkspaceId(workspace.id, {
		creatorUserId: principal.userId,
	});
	return c.json({
		success: true,
		data: keys.map((row) => ({
			id: row.id,
			workspaceId: row.workspace_id,
			key: `${row.key.slice(0, 8)}…${row.key.slice(-4)}`,
			name: row.name,
			status: row.status,
			limit: gatewayKeyLimitAmount(row.limit_micros),
			limitReset: row.limit_reset,
			expiresAt: row.expires_at,
			lastUsedAt: row.last_used_at,
			createdAt: row.created_at,
		})),
	});
});

userGatewayKeysRoutes.post('/', async (c) => {
	c.header('Cache-Control', 'private, no-store');
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const workspace = c.get('workspaceContext').currentWorkspace;
	const body = (await c.req.json().catch(() => null)) as {
		name?: unknown;
		expires_at?: unknown;
		limit?: unknown;
		limit_reset?: unknown;
	} | null;
	const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 128) : 'portal key';
	const now = new Date();
	if (
		body?.expires_at !== undefined &&
		body.expires_at !== null &&
		typeof body.expires_at !== 'string'
	) {
		return c.json({ success: false, message: 'Gateway API key expiry is invalid' }, 400);
	}
	let expiresAt: string | null;
	let limitMicros: number | null;
	let limitReset: 'daily' | 'weekly' | 'monthly' | null;
	try {
		expiresAt = normalizeFutureKeyExpiry(
			body?.expires_at as string | null | undefined,
			now.toISOString(),
			'Gateway',
		);
		limitMicros = normalizeGatewayKeyLimitMicros(body?.limit);
		limitReset = normalizeGatewayKeyLimitReset(body?.limit_reset);
	} catch (error) {
		if (error instanceof TypeError) {
			return c.json({ success: false, message: error.message }, 400);
		}
		throw error;
	}
	const created = await createKey(repositories, {
		user_id: principal.userId,
		workspace_id: workspace.id,
		name,
		expires_at: expiresAt,
		limit_micros: limitMicros,
		limit_reset: limitReset,
		now,
		provision_reason: 'User portal self-service key',
		actor_id: `portal:${principal.userId}`,
		actor_type: 'user',
	});
	return c.json({ success: true, data: created });
});

userGatewayKeysRoutes.delete('/:id', async (c) => {
	c.header('Cache-Control', 'private, no-store');
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const workspace = c.get('workspaceContext').currentWorkspace;
	const id = c.req.param('id');
	const row = await repositories.apiKeys.getApiKeyByIdInWorkspace(id, workspace.id);
	if (!row || row.user_id !== principal.userId) {
		return c.json({ success: false, message: 'Not found' }, 404);
	}
	const revoked = await repositories.apiKeys.revokeApiKeyInWorkspace(id, workspace.id, principal.userId);
	if (!revoked) return c.json({ success: false, message: 'Not found' }, 404);
	return c.json({ success: true });
});
