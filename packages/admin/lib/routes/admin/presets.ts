import { Hono } from 'hono';
import type { UpdateRequestPresetMetadataPatch } from '@octafuse/core';
import type { AdminEnv } from '@/lib/admin-env';
import { requestPresetResponse, requestPresetVersionResponse } from '@/lib/request-preset-response';

export const adminPresetsRoutes = new Hono<AdminEnv>();

adminPresetsRoutes.get('/', async (c) => {
	const rows = await c.get('repositories').requestPresets.listAll(true);
	return c.json({ success: true, data: rows.map(requestPresetResponse) });
});

adminPresetsRoutes.get('/:id/versions', async (c) => {
	const row = await c.get('repositories').requestPresets.getById(c.req.param('id'));
	if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	const versions = await c.get('repositories').requestPresets.listVersions(row.id);
	return c.json({ success: true, data: versions.map(requestPresetVersionResponse) });
});

adminPresetsRoutes.patch('/:id', async (c) => {
	const row = await c.get('repositories').requestPresets.getById(c.req.param('id'));
	if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	const body = await c.req.json<Record<string, unknown>>().catch(() => null);
	if (!body) return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	const patch: UpdateRequestPresetMetadataPatch = { nowIso: new Date().toISOString() };
	if (body.name !== undefined) {
		if (typeof body.name !== 'string' || !body.name.trim()) return c.json({ success: false, message: 'Name is required' }, 400);
		patch.name = body.name.trim().slice(0, 128);
	}
	if (body.description === null || typeof body.description === 'string') patch.description = typeof body.description === 'string' ? body.description.trim().slice(0, 1024) || null : null;
	if (body.visibility !== undefined) {
		if (body.visibility !== 'private' && body.visibility !== 'public') return c.json({ success: false, message: 'Invalid visibility' }, 400);
		patch.visibility = body.visibility;
	}
	if (body.status !== undefined) {
		if (body.status !== 'active' && body.status !== 'archived') return c.json({ success: false, message: 'Invalid status' }, 400);
		patch.status = body.status;
	}
	await c.get('repositories').requestPresets.updateMetadata(row.id, patch);
	const updated = await c.get('repositories').requestPresets.getById(row.id);
	return c.json({ success: true, data: updated ? requestPresetResponse(updated) : null });
});

adminPresetsRoutes.post('/:id/designate', async (c) => {
	const body = await c.req.json<{ version?: unknown }>().catch(() => null);
	const version = Number(body?.version);
	if (!Number.isInteger(version) || version < 1) return c.json({ success: false, message: 'Invalid version' }, 400);
	const changed = await c.get('repositories').requestPresets.designateVersion(c.req.param('id'), version, new Date().toISOString());
	if (!changed) return c.json({ success: false, message: 'Preset or version not found' }, 404);
	const updated = await c.get('repositories').requestPresets.getById(c.req.param('id'));
	return c.json({ success: true, data: updated ? requestPresetResponse(updated) : null });
});
