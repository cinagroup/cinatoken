import { Hono, type Context } from 'hono';
import {
	saveGuardrailVersion,
	type GuardrailScopeType,
	type UpdateGuardrailMetadataPatch,
} from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';
import { guardrailAssignmentResponse, guardrailResponse, guardrailVersionResponse } from '@/lib/guardrail-response';
import { buildGuardrailPreviewForRequest } from '@/lib/services/guardrail-preview';

export const userGuardrailsRoutes = new Hono<UserEnv>();

async function owned(c: Context<UserEnv>, id: string) {
	const workspaceId = c.get('workspaceContext').currentWorkspace.id;
	const row = await c.get('repositories').guardrails.getByIdInWorkspace(id, workspaceId);
	return row && row.owner_user_id === c.get('principal').userId ? row : null;
}

async function visible(c: Context<UserEnv>, id: string) {
	return c.get('repositories').guardrails.getByIdInWorkspace(
		id,
		c.get('workspaceContext').currentWorkspace.id,
	);
}

async function isAdminManaged(c: Context<UserEnv>, guardrailId: string): Promise<boolean> {
	return (await c.get('repositories').guardrails.listAssignments(guardrailId)).some((assignment) => assignment.created_by_user_id === null);
}

async function ownedScope(c: Context<UserEnv>, scopeType: GuardrailScopeType, scopeId: string): Promise<boolean> {
	const userId = c.get('principal').userId;
	if (scopeType === 'user') return scopeId === userId;
	const key = await c.get('repositories').apiKeys.getApiKeyByIdInWorkspace(
		scopeId,
		c.get('workspaceContext').currentWorkspace.id,
	);
	return key?.user_id === userId;
}

userGuardrailsRoutes.get('/', async (c) => {
	const workspaceId = c.get('workspaceContext').currentWorkspace.id;
	const rows = await c.get('repositories').guardrails.listOwnedByWorkspace(workspaceId, c.get('principal').userId, true);
	return c.json({ success: true, data: { workspaceId, guardrails: rows.map(guardrailResponse) } });
});

userGuardrailsRoutes.get('/effective', async (c) => {
	const workspaceId = c.get('workspaceContext').currentWorkspace.id;
	const userId = c.get('principal').userId;
	const apiKeyId = c.req.query('api_key_id')?.trim() || null;
	if (apiKeyId && apiKeyId.length > 256) {
		return c.json({ success: false, message: 'api_key_id is invalid' }, 400);
	}
	if (apiKeyId) {
		const key = await c.get('repositories').apiKeys.getApiKeyByIdInWorkspace(apiKeyId, workspaceId);
		if (!key || key.user_id !== userId || key.status !== 'active') {
			return c.json({ success: false, message: 'Gateway key not found' }, 404);
		}
	}
	const preview = await buildGuardrailPreviewForRequest(c.get('repositories'), { workspaceId, userId, apiKeyId });
	c.header('Cache-Control', 'private, no-store');
	return preview.ok
		? c.json({ success: true, data: { workspaceId, apiKeyId, ...preview.value } })
		: c.json({ success: false, message: preview.message, trace: preview.trace }, 409);
});

userGuardrailsRoutes.post('/', async (c) => {
	const body = await c.req.json<Record<string, unknown>>().catch(() => null);
	if (!body) return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	const result = await saveGuardrailVersion(c.get('repositories'), {
		workspaceId: c.get('workspaceContext').currentWorkspace.id,
		ownerUserId: c.get('principal').userId, name: body.name, description: body.description, config: body.config,
	});
	if (!result.ok) return c.json({ success: false, message: result.message }, result.status);
	return c.json({ success: true, data: guardrailResponse(result.guardrail) }, 201);
});

userGuardrailsRoutes.post('/:id/versions', async (c) => {
	const row = await owned(c, c.req.param('id'));
	if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	if (await isAdminManaged(c, row.id)) return c.json({ success: false, message: 'Administrator-managed guardrails are read-only' }, 403);
	const body = await c.req.json<Record<string, unknown>>().catch(() => null);
	if (!body) return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	if ((row.is_workspace_default || row.is_account_default) && body.name !== undefined && body.name !== row.name) {
		return c.json({ success: false, message: 'Default Guardrail name is immutable' }, 400);
	}
	const result = await saveGuardrailVersion(c.get('repositories'), {
		workspaceId: row.workspace_id,
		ownerUserId: c.get('principal').userId, id: row.id,
		name: body.name ?? row.name, description: body.description ?? row.description, config: body.config,
		preserveAdminManaged: true,
	});
	if (!result.ok) return c.json({ success: false, message: result.message }, result.status);
	return c.json({ success: true, data: guardrailResponse(result.guardrail) }, 201);
});

userGuardrailsRoutes.get('/:id/versions', async (c) => {
	const row = await visible(c, c.req.param('id')); if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	return c.json({ success: true, data: (await c.get('repositories').guardrails.listVersions(row.id)).map(guardrailVersionResponse) });
});

userGuardrailsRoutes.get('/:id/assignments', async (c) => {
	const row = await visible(c, c.req.param('id')); if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	return c.json({ success: true, data: (await c.get('repositories').guardrails.listAssignments(row.id)).map(guardrailAssignmentResponse) });
});

userGuardrailsRoutes.put('/:id/assignments', async (c) => {
	const row = await owned(c, c.req.param('id')); if (!row || row.status !== 'active') return c.json({ success: false, message: 'Not found or archived' }, 404);
	if (row.is_workspace_default || row.is_account_default) return c.json({ success: false, message: 'Default Guardrails apply implicitly and cannot be assigned' }, 400);
	const body = await c.req.json<{ scope_type?: unknown; scope_id?: unknown }>().catch(() => null);
	if (!body || (body.scope_type !== 'user' && body.scope_type !== 'api_key') || typeof body.scope_id !== 'string' || !body.scope_id) return c.json({ success: false, message: 'Invalid assignment scope' }, 400);
	if (!(await ownedScope(c, body.scope_type, body.scope_id))) return c.json({ success: false, message: 'Assignment scope is not owned by this user' }, 403);
	const userId = c.get('principal').userId;
	const assignment = await c.get('repositories').guardrails.upsertAssignment({ id: crypto.randomUUID(), workspaceId: row.workspace_id, guardrailId: row.id, scopeType: body.scope_type, scopeId: body.scope_id, createdByUserId: userId, nowIso: new Date().toISOString(), preserveAdminManaged: true });
	if (assignment.created_by_user_id !== userId) return c.json({ success: false, message: 'This scope is managed by an administrator' }, 403);
	return c.json({ success: true, data: guardrailAssignmentResponse(assignment) });
});

userGuardrailsRoutes.delete('/assignments/:scopeType/:scopeId', async (c) => {
	const scopeType = c.req.param('scopeType'); const scopeId = c.req.param('scopeId');
	if ((scopeType !== 'user' && scopeType !== 'api_key') || !(await ownedScope(c, scopeType, scopeId))) return c.json({ success: false, message: 'Not found' }, 404);
	const removed = await c.get('repositories').guardrails.deleteAssignment(c.get('workspaceContext').currentWorkspace.id, scopeType, scopeId, c.get('principal').userId);
	if (!removed) return c.json({ success: false, message: 'This scope is managed by an administrator or has no user assignment' }, 403);
	return c.json({ success: true, removed: true });
});

userGuardrailsRoutes.patch('/:id', async (c) => {
	const row = await owned(c, c.req.param('id')); if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	if (await isAdminManaged(c, row.id)) return c.json({ success: false, message: 'Administrator-managed guardrails are read-only' }, 403);
	const body = await c.req.json<Record<string, unknown>>().catch(() => null); if (!body) return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	if ((row.is_workspace_default || row.is_account_default) && (body.name !== undefined || body.status !== undefined)) {
		return c.json({ success: false, message: 'Default Guardrail name and status are immutable' }, 400);
	}
	const patch: UpdateGuardrailMetadataPatch = { nowIso: new Date().toISOString(), preserveAdminManaged: true };
	if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim()) return c.json({ success: false, message: 'Name is required' }, 400); patch.name = body.name.trim().slice(0, 128); }
	if (body.description === null || typeof body.description === 'string') patch.description = typeof body.description === 'string' ? body.description.trim().slice(0, 1024) || null : null;
	if (body.status !== undefined) { if (body.status !== 'active' && body.status !== 'archived') return c.json({ success: false, message: 'Invalid status' }, 400); patch.status = body.status; }
	if (!(await c.get('repositories').guardrails.updateMetadata(row.id, patch))) {
		if (await isAdminManaged(c, row.id)) return c.json({ success: false, message: 'Administrator-managed guardrails are read-only' }, 403);
		return c.json({ success: false, message: 'Guardrail changed while the update was being applied' }, 409);
	}
	const updated = await c.get('repositories').guardrails.getByIdInWorkspace(row.id, row.workspace_id); return c.json({ success: true, data: updated ? guardrailResponse(updated) : null });
});

userGuardrailsRoutes.post('/:id/designate', async (c) => {
	const row = await owned(c, c.req.param('id')); if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	if (await isAdminManaged(c, row.id)) return c.json({ success: false, message: 'Administrator-managed guardrails are read-only' }, 403);
	const body = await c.req.json<{ version?: unknown }>().catch(() => null); const version = Number(body?.version);
	if (!Number.isInteger(version) || version < 1) return c.json({ success: false, message: 'Invalid version' }, 400);
	if (!(await c.get('repositories').guardrails.designateVersion(row.id, version, new Date().toISOString(), { preserveAdminManaged: true }))) {
		if (await isAdminManaged(c, row.id)) return c.json({ success: false, message: 'Administrator-managed guardrails are read-only' }, 403);
		return c.json({ success: false, message: 'Version not found or guardrail archived' }, 404);
	}
	const updated = await c.get('repositories').guardrails.getByIdInWorkspace(row.id, row.workspace_id); return c.json({ success: true, data: updated ? guardrailResponse(updated) : null });
});

userGuardrailsRoutes.delete('/:id', async (c) => {
	const row = await owned(c, c.req.param('id')); if (!row) return c.json({ success: false, message: 'Not found' }, 404);
	if (row.is_workspace_default || row.is_account_default) return c.json({ success: false, message: 'Default Guardrails cannot be archived' }, 403);
	if (await isAdminManaged(c, row.id)) return c.json({ success: false, message: 'Administrator-managed guardrails are read-only' }, 403);
	if (!(await c.get('repositories').guardrails.updateMetadata(row.id, { status: 'archived', nowIso: new Date().toISOString(), preserveAdminManaged: true }))) {
		if (await isAdminManaged(c, row.id)) return c.json({ success: false, message: 'Administrator-managed guardrails are read-only' }, 403);
		return c.json({ success: false, message: 'Guardrail changed while it was being archived' }, 409);
	}
	return c.json({ success: true });
});
