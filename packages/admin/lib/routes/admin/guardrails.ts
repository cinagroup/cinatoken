import { Hono } from 'hono';
import {
	getAccessibleWorkspaceForSubject,
	type GuardrailScopeType,
	type UpdateGuardrailMetadataPatch,
} from '@octafuse/core';
import type { AdminEnv } from '@/lib/admin-env';
import { guardrailAssignmentResponse, guardrailResponse, guardrailVersionResponse } from '@/lib/guardrail-response';
import { buildGuardrailPreviewForRequest } from '@/lib/services/guardrail-preview';

export const adminGuardrailsRoutes = new Hono<AdminEnv>();

adminGuardrailsRoutes.get('/', async (c) => c.json({ success: true, data: (await c.get('repositories').guardrails.listAll(true)).map(guardrailResponse) }));
adminGuardrailsRoutes.get('/effective', async (c) => {
	const workspaceId = c.req.query('workspace_id')?.trim() ?? '';
	const userId = c.req.query('user_id')?.trim() ?? '';
	const apiKeyId = c.req.query('api_key_id')?.trim() || null;
	if (!workspaceId || workspaceId.length > 600 || !userId || userId.length > 256
		|| (apiKeyId != null && apiKeyId.length > 256)) {
		return c.json({ success: false, message: 'workspace_id and user_id are required' }, 400);
	}
	const user = await c.get('repositories').users.getById(userId);
	if (!user) return c.json({ success: false, message: 'User or Workspace not found' }, 404);
	const workspace = await getAccessibleWorkspaceForSubject(c.get('repositories').client, {
		userId: user.id,
		subject: user.external_user_id ?? user.id,
		workspaceId,
	});
	if (!workspace) return c.json({ success: false, message: 'User or Workspace not found' }, 404);
	if (apiKeyId) {
		const key = await c.get('repositories').apiKeys.getApiKeyByIdInWorkspace(apiKeyId, workspaceId);
		if (!key || key.user_id !== userId || key.status !== 'active') {
			return c.json({ success: false, message: 'Gateway key not found' }, 404);
		}
	}
	const preview = await buildGuardrailPreviewForRequest(c.get('repositories'), { workspaceId, userId, apiKeyId });
	c.header('Cache-Control', 'private, no-store');
	return preview.ok
		? c.json({ success: true, data: { workspaceId, userId, apiKeyId, ...preview.value } })
		: c.json({ success: false, message: preview.message, trace: preview.trace }, 409);
});
adminGuardrailsRoutes.get('/:id/versions', async (c) => {
	const row = await c.get('repositories').guardrails.getById(c.req.param('id')); if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	return c.json({ success: true, data: (await c.get('repositories').guardrails.listVersions(row.id)).map(guardrailVersionResponse) });
});
adminGuardrailsRoutes.get('/:id/assignments', async (c) => {
	const row = await c.get('repositories').guardrails.getById(c.req.param('id')); if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	return c.json({ success: true, data: (await c.get('repositories').guardrails.listAssignments(row.id)).map(guardrailAssignmentResponse) });
});
adminGuardrailsRoutes.put('/:id/assignments', async (c) => {
	const row = await c.get('repositories').guardrails.getById(c.req.param('id')); if (!row || row.status !== 'active') return c.json({ success: false, message: 'Not found or archived' }, 404);
	if (row.is_workspace_default || row.is_account_default) return c.json({ success: false, message: 'Default Guardrails apply implicitly and cannot be assigned' }, 400);
	const body = await c.req.json<{ scope_type?: unknown; scope_id?: unknown }>().catch(() => null);
	if (!body || (body.scope_type !== 'user' && body.scope_type !== 'api_key') || typeof body.scope_id !== 'string' || !body.scope_id) return c.json({ success: false, message: 'Invalid assignment scope' }, 400);
	if (body.scope_type === 'api_key') {
		const key = await c.get('repositories').apiKeys.getApiKeyByIdInWorkspace(body.scope_id, row.workspace_id);
		if (!key) return c.json({ success: false, message: 'Assignment scope not found in this workspace' }, 404);
	} else {
		const user = await c.get('repositories').users.getById(body.scope_id);
		if (!user) return c.json({ success: false, message: 'Assignment scope not found' }, 404);
		const workspace = await getAccessibleWorkspaceForSubject(c.get('repositories').client, {
			userId: user.id,
			subject: user.external_user_id ?? user.id,
			workspaceId: row.workspace_id,
		});
		if (!workspace) return c.json({ success: false, message: 'User is not a member of this workspace' }, 404);
	}
	const assignment = await c.get('repositories').guardrails.upsertAssignment({ id: crypto.randomUUID(), workspaceId: row.workspace_id, guardrailId: row.id, scopeType: body.scope_type, scopeId: body.scope_id, createdByUserId: null, nowIso: new Date().toISOString() });
	return c.json({ success: true, data: guardrailAssignmentResponse(assignment) });
});
adminGuardrailsRoutes.delete('/assignments/:scopeType/:scopeId', async (c) => {
	const scopeType = c.req.param('scopeType') as GuardrailScopeType; if (scopeType !== 'user' && scopeType !== 'api_key') return c.json({ success: false, message: 'Invalid scope' }, 400);
	const workspaceId = c.req.query('workspace_id')?.trim();
	if (!workspaceId) return c.json({ success: false, message: 'workspace_id is required' }, 400);
	return c.json({ success: true, removed: await c.get('repositories').guardrails.deleteAssignment(workspaceId, scopeType, c.req.param('scopeId')) });
});
adminGuardrailsRoutes.patch('/:id', async (c) => {
	const row = await c.get('repositories').guardrails.getById(c.req.param('id')); if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	const body = await c.req.json<Record<string, unknown>>().catch(() => null); if (!body) return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	if ((row.is_workspace_default || row.is_account_default) && (body.name !== undefined || body.status !== undefined)) return c.json({ success: false, message: 'Default Guardrail name and status are immutable' }, 400);
	const patch: UpdateGuardrailMetadataPatch = { nowIso: new Date().toISOString() };
	if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim()) return c.json({ success: false, message: 'Name is required' }, 400); patch.name = body.name.trim().slice(0, 128); }
	if (body.description === null || typeof body.description === 'string') patch.description = typeof body.description === 'string' ? body.description.trim().slice(0, 1024) || null : null;
	if (body.status !== undefined) { if (body.status !== 'active' && body.status !== 'archived') return c.json({ success: false, message: 'Invalid status' }, 400); patch.status = body.status; }
	if (!(await c.get('repositories').guardrails.updateMetadata(row.id, patch))) return c.json({ success: false, message: 'Guardrail changed while the update was being applied' }, 409);
	const updated = await c.get('repositories').guardrails.getById(row.id); return c.json({ success: true, data: updated ? guardrailResponse(updated) : null });
});
adminGuardrailsRoutes.post('/:id/designate', async (c) => {
	const body = await c.req.json<{ version?: unknown }>().catch(() => null); const version = Number(body?.version); if (!Number.isInteger(version) || version < 1) return c.json({ success: false, message: 'Invalid version' }, 400);
	if (!(await c.get('repositories').guardrails.designateVersion(c.req.param('id'), version, new Date().toISOString()))) return c.json({ success: false, message: 'Guardrail or version not found' }, 404);
	const updated = await c.get('repositories').guardrails.getById(c.req.param('id')); return c.json({ success: true, data: updated ? guardrailResponse(updated) : null });
});
