/**
 * 用户路由：`/user/shared-keys` — 卖家共享密钥上架/管理。
 * 明文密钥仅创建响应回显一次；列表只返回掩码 + 指纹。
 */
import { Hono } from 'hono';
import {
	fingerprintProviderApiKey,
	getSharedChannelDefinition,
	isSharedKeyChannelType,
	maskProviderApiKeyForAdmin,
	roundGatewayMoney,
	SHARED_KEY_CHANNEL_TYPES,
} from '@octafuse/core';
import type { SharedKeyRow } from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';
import { loadPortalMarketplaceConfig } from '@/lib/portal-config';
import { validateSharedKey } from '@/lib/shared-key-validation';

export const userSharedKeysRoutes = new Hono<UserEnv>();

type CreateSharedKeyBody = {
	channelType?: unknown;
	apiKey?: unknown;
	label?: unknown;
	weight?: unknown;
	inputPrice?: unknown;
	outputPrice?: unknown;
	cacheReadPrice?: unknown;
	cacheWritePrice?: unknown;
};

type UpdateSharedKeyBody = {
	label?: unknown;
	weight?: unknown;
	status?: unknown;
	inputPrice?: unknown;
	outputPrice?: unknown;
	cacheReadPrice?: unknown;
	cacheWritePrice?: unknown;
};

const toPrice = (value: unknown): number | null => {
	if (value === null || value === undefined || value === '') return null;
	const num = Number(value);
	if (!Number.isFinite(num) || num < 0) return null;
	return roundGatewayMoney(num);
};

const toWeight = (value: unknown): number | null => {
	if (value === undefined || value === null) return null;
	const num = Number(value);
	if (!Number.isInteger(num) || num < 1 || num > 100) return null;
	return num;
};

function maskSharedKey(row: SharedKeyRow) {
	const { apiKey, ...rest } = row;
	void apiKey;
	return { ...rest, apiKeyMasked: maskProviderApiKeyForAdmin(row.apiKey) };
}

userSharedKeysRoutes.get('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const rows = await repositories.sharedKeys.listSharedKeysBySeller(principal.userId);
	return c.json({ success: true, data: rows.map(maskSharedKey) });
});

userSharedKeysRoutes.get('/channels', async (c) => {
	const repositories = c.get('repositories');
	const config = await loadPortalMarketplaceConfig(repositories);
	const allowed =
		config.enabledChannels.length > 0
			? SHARED_KEY_CHANNEL_TYPES.filter((item) => config.enabledChannels.includes(item))
			: SHARED_KEY_CHANNEL_TYPES;
	const channels = allowed.map((channelType) => {
		const definition = getSharedChannelDefinition(channelType);
		return {
			channelType,
			label: definition?.label ?? channelType,
			modelsUrl: definition?.modelsUrl ?? null,
		};
	});
	return c.json({
		success: true,
		data: {
			channels,
			limits: {
				maxInputPrice: config.maxInputPrice,
				maxOutputPrice: config.maxOutputPrice,
				commissionRate: config.commissionRate,
			},
		},
	});
});

userSharedKeysRoutes.post('/', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const body = (await c.req.json().catch(() => null)) as CreateSharedKeyBody | null;

	const channelType = typeof body?.channelType === 'string' ? body.channelType : '';
	const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
	const weight = toWeight(body?.weight) ?? 1;
	const inputPrice = toPrice(body?.inputPrice);
	const outputPrice = toPrice(body?.outputPrice);
	const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 128) : null;
	const cacheReadPrice = toPrice(body?.cacheReadPrice);
	const cacheWritePrice = toPrice(body?.cacheWritePrice);

	if (!isSharedKeyChannelType(channelType)) {
		return c.json({ success: false, message: '不支持的渠道（仅限官方渠道白名单）' }, 400);
	}
	if (apiKey.length < 8) {
		return c.json({ success: false, message: 'API Key 格式无效' }, 400);
	}
	if (inputPrice === null || outputPrice === null || inputPrice === 0 || outputPrice === 0) {
		return c.json({ success: false, message: '输入/输出单价必须大于 0' }, 400);
	}

	const config = await loadPortalMarketplaceConfig(repositories);
	if (config.enabledChannels.length > 0 && !config.enabledChannels.includes(channelType)) {
		return c.json({ success: false, message: '该渠道当前未开放共享' }, 403);
	}
	if (inputPrice > config.maxInputPrice || outputPrice > config.maxOutputPrice) {
		return c.json({ success: false, message: `单价超出上限（输入 ≤ ${config.maxInputPrice}，输出 ≤ ${config.maxOutputPrice} / 1M tokens）` }, 400);
	}

	const fingerprint = fingerprintProviderApiKey(apiKey);
	const existing = await repositories.sharedKeys.listSharedKeysBySeller(principal.userId);
	if (existing.some((row) => row.keyFingerprint === fingerprint)) {
		return c.json({ success: false, message: '该密钥已上架，请勿重复提交' }, 409);
	}

	const id = crypto.randomUUID();
	const nowIso = new Date().toISOString();
	await repositories.sharedKeys.insertSharedKey({
		id,
		sellerUserId: principal.userId,
		channelType,
		apiKey,
		keyFingerprint: fingerprint,
		label,
		weight,
		inputPrice,
		outputPrice,
		cacheReadPrice,
		cacheWritePrice,
		nowIso,
	});

	// 上架即校验：官方渠道 models 端点确认 key 有效后才进入调度池
	const validation = await validateSharedKey(channelType, apiKey);
	if (validation.valid) {
		await repositories.sharedKeys.updateSharedKey(id, {
			status: 'active',
			failureReason: null,
		});
	} else if (!validation.inconclusive) {
		await repositories.sharedKeys.markSharedKeyFailure(id, validation.reason ?? 'validation failed', new Date().toISOString());
	}

	const row = await repositories.sharedKeys.getSharedKeyById(id);
	if (!row) {
		return c.json({ success: false, message: '创建失败' }, 500);
	}
	return c.json({
		success: true,
		data: {
			...maskSharedKey(row),
			// 明文仅此一次回显
			apiKey,
			validation: validation.valid
				? 'active'
				: validation.inconclusive
					? 'validating'
					: 'invalid',
			validationReason: validation.valid ? null : validation.reason,
		},
	});
});

userSharedKeysRoutes.patch('/:id', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const id = c.req.param('id');
	const row = await repositories.sharedKeys.getSharedKeyById(id);
	if (!row || row.sellerUserId !== principal.userId) {
		return c.json({ success: false, message: 'Not found' }, 404);
	}
	const body = (await c.req.json().catch(() => null)) as UpdateSharedKeyBody | null;
	if (!body) return c.json({ success: false, message: 'Invalid body' }, 400);

	const config = await loadPortalMarketplaceConfig(repositories);
	const patch: Record<string, unknown> = {};

	if (body.label !== undefined) {
		patch.label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 128) : null;
	}
	const weight = toWeight(body.weight);
	if (weight !== null) patch.weight = weight;
	if (body.status === 'paused' || body.status === 'active') {
		if (body.status === 'active' && row.status === 'invalid') {
			return c.json({ success: false, message: '密钥已失效，无法直接恢复；请删除后重新上架' }, 400);
		}
		patch.status = body.status;
	}
	const inputPrice = toPrice(body.inputPrice);
	if (inputPrice !== null) {
		if (inputPrice === 0 || inputPrice > config.maxInputPrice) {
			return c.json({ success: false, message: '输入单价超出允许范围' }, 400);
		}
		patch.inputPrice = inputPrice;
	}
	const outputPrice = toPrice(body.outputPrice);
	if (outputPrice !== null) {
		if (outputPrice === 0 || outputPrice > config.maxOutputPrice) {
			return c.json({ success: false, message: '输出单价超出允许范围' }, 400);
		}
		patch.outputPrice = outputPrice;
	}
	if (body.cacheReadPrice !== undefined) patch.cacheReadPrice = toPrice(body.cacheReadPrice);
	if (body.cacheWritePrice !== undefined) patch.cacheWritePrice = toPrice(body.cacheWritePrice);

	if (Object.keys(patch).length === 0) {
		return c.json({ success: false, message: '无可更新字段' }, 400);
	}
	await repositories.sharedKeys.updateSharedKey(id, patch);
	const updated = await repositories.sharedKeys.getSharedKeyById(id);
	return c.json({ success: true, data: updated ? maskSharedKey(updated) : null });
});

userSharedKeysRoutes.delete('/:id', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const id = c.req.param('id');
	const row = await repositories.sharedKeys.getSharedKeyById(id);
	if (!row || row.sellerUserId !== principal.userId) {
		return c.json({ success: false, message: 'Not found' }, 404);
	}
	await repositories.sharedKeys.deleteSharedKey(id);
	return c.json({ success: true });
});

userSharedKeysRoutes.post('/:id/revalidate', async (c) => {
	const repositories = c.get('repositories');
	const principal = c.get('principal');
	const id = c.req.param('id');
	const row = await repositories.sharedKeys.getSharedKeyById(id);
	if (!row || row.sellerUserId !== principal.userId) {
		return c.json({ success: false, message: 'Not found' }, 404);
	}
	if (row.status === 'disabled') {
		return c.json({ success: false, message: '密钥已被管理员停用' }, 403);
	}
	const validation = await validateSharedKey(row.channelType, row.apiKey);
	const nowIso = new Date().toISOString();
	if (validation.valid) {
		await repositories.sharedKeys.updateSharedKey(id, {
			status: 'active',
			failureReason: null,
		});
	} else if (!validation.inconclusive) {
		await repositories.sharedKeys.markSharedKeyFailure(id, validation.reason ?? 'validation failed', nowIso);
	}
	const updated = await repositories.sharedKeys.getSharedKeyById(id);
	return c.json({ success: true, data: updated ? maskSharedKey(updated) : null });
});
