import { Hono, type Context } from 'hono';
import { saveRequestPresetVersion, type UpdateRequestPresetMetadataPatch } from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';
import { requestPresetResponse, requestPresetVersionResponse } from '@/lib/request-preset-response';

export const userPresetsRoutes = new Hono<UserEnv>();

async function ownedPreset(c: Context<UserEnv>, id: string) {
	const workspaceId = c.get('workspaceContext').currentWorkspace.id;
	const row = await c.get('repositories').requestPresets.getByIdInWorkspace(id, workspaceId);
	return row && row.owner_user_id === c.get('principal').userId ? row : null;
}

userPresetsRoutes.get('/', async (c) => {
	const workspaceId = c.get('workspaceContext').currentWorkspace.id;
	const rows = await c.get('repositories').requestPresets.listOwnedByWorkspace(workspaceId, c.get('principal').userId, true);
	return c.json({ success: true, data: { workspaceId, presets: rows.map(requestPresetResponse) } });
});

userPresetsRoutes.post('/', async (c) => {
	const body = await c.req.json<Record<string, unknown>>().catch(() => null);
	if (!body) return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	if (body.systemPrompt !== undefined && body.systemPrompt !== null && typeof body.systemPrompt !== 'string') {
		return c.json({ success: false, message: 'Invalid system prompt' }, 400);
	}
	const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : null;
	try {
		const result = await saveRequestPresetVersion(c.get('repositories'), {
			workspaceId: c.get('workspaceContext').currentWorkspace.id,
			ownerUserId: c.get('principal').userId,
			slug: body.slug,
			name: body.name,
			description: body.description,
			visibility: body.visibility,
			systemPrompt,
			config: body.config,
		});
		if (!result.ok) return c.json({ success: false, message: result.message }, result.status);
		return c.json({ success: true, data: requestPresetResponse(result.preset) }, 201);
	} catch (error) {
		console.error('[User Presets] save failed', error instanceof Error ? error.message : 'unknown');
		return c.json({ success: false, message: 'Preset changed concurrently; reload and retry' }, 409);
	}
});

userPresetsRoutes.get('/:id/versions', async (c) => {
	const row = await ownedPreset(c, c.req.param('id'));
	if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	const versions = await c.get('repositories').requestPresets.listVersions(row.id);
	return c.json({ success: true, data: versions.map(requestPresetVersionResponse) });
});

userPresetsRoutes.patch('/:id', async (c) => {
	const row = await ownedPreset(c, c.req.param('id'));
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
	const updated = await c.get('repositories').requestPresets.getByIdInWorkspace(row.id, row.workspace_id);
	return c.json({ success: true, data: updated ? requestPresetResponse(updated) : null });
});

userPresetsRoutes.post('/:id/designate', async (c) => {
	const row = await ownedPreset(c, c.req.param('id'));
	if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	const body = await c.req.json<{ version?: unknown }>().catch(() => null);
	const version = Number(body?.version);
	if (!Number.isInteger(version) || version < 1) return c.json({ success: false, message: 'Invalid version' }, 400);
	const changed = await c.get('repositories').requestPresets.designateVersion(row.id, version, new Date().toISOString());
	if (!changed) return c.json({ success: false, message: 'Version not found or preset archived' }, 404);
	const updated = await c.get('repositories').requestPresets.getByIdInWorkspace(row.id, row.workspace_id);
	return c.json({ success: true, data: updated ? requestPresetResponse(updated) : null });
});

userPresetsRoutes.delete('/:id', async (c) => {
	const row = await ownedPreset(c, c.req.param('id'));
	if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	await c.get('repositories').requestPresets.updateMetadata(row.id, { status: 'archived', nowIso: new Date().toISOString() });
	return c.json({ success: true });
});
