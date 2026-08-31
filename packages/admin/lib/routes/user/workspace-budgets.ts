import {
	deleteWorkspaceBudget,
	listWorkspaceBudgets,
	normalizeWorkspaceBudgetInterval,
	normalizeWorkspaceBudgetLimitMicros,
	upsertWorkspaceBudget,
	workspaceBudgetAmount,
	type WorkspaceBudgetRow,
} from '@octafuse/core';
import { Hono, type Context } from 'hono';
import type { UserEnv } from '@/lib/user-env';
import { hasAuthoritativeOrganizationAdminRole } from '@/lib/cinaauth/organization-admin-roles';

export const userWorkspaceBudgetsRoutes = new Hono<UserEnv>();

function response(row: WorkspaceBudgetRow) {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		limitUsd: workspaceBudgetAmount(row.limit_micros),
		resetInterval: row.reset_interval,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function canManage(c: Context<UserEnv>): boolean {
	const workspace = c.get('workspaceContext').currentWorkspace;
	return workspace.role === 'owner'
		|| workspace.role === 'admin'
		|| hasAuthoritativeOrganizationAdminRole(
			workspace,
			c.env?.CINAAUTH_ORGANIZATION_ADMIN_ROLES,
		);
}

userWorkspaceBudgetsRoutes.get('/', async (c) => {
	const workspaceId = c.get('workspaceContext').currentWorkspace.id;
	const rows = await listWorkspaceBudgets(c.get('repositories').client, workspaceId);
	c.header('Cache-Control', 'private, no-store');
	return c.json({ success: true, data: rows.map(response) });
});

userWorkspaceBudgetsRoutes.put('/:interval', async (c) => {
	if (!canManage(c)) {
		return c.json({ success: false, message: 'Workspace administrator access is required' }, 403);
	}
	let interval;
	try {
		interval = normalizeWorkspaceBudgetInterval(c.req.param('interval'));
	} catch (error) {
		return c.json({ success: false, message: error instanceof Error ? error.message : 'Invalid interval' }, 400);
	}
	const body = await c.req.json<unknown>().catch(() => null);
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	}
	const fields = Object.keys(body);
	if (fields.length !== 1 || fields[0] !== 'limit_usd') {
		return c.json({ success: false, message: 'limit_usd is the only supported field' }, 400);
	}
	let limitMicros: number;
	try {
		limitMicros = normalizeWorkspaceBudgetLimitMicros((body as Record<string, unknown>).limit_usd);
	} catch (error) {
		return c.json({ success: false, message: error instanceof Error ? error.message : 'Invalid budget limit' }, 400);
	}
	try {
		const workspaceId = c.get('workspaceContext').currentWorkspace.id;
		const row = await upsertWorkspaceBudget(c.get('repositories').client, {
			workspaceId,
			interval,
			limitMicros,
		});
		if (!row) return c.json({ success: false, message: 'Workspace not found' }, 404);
		c.header('Cache-Control', 'private, no-store');
		return c.json({ success: true, data: response(row) });
	} catch (error) {
		if (error instanceof TypeError) return c.json({ success: false, message: error.message }, 400);
		throw error;
	}
});

userWorkspaceBudgetsRoutes.delete('/:interval', async (c) => {
	if (!canManage(c)) {
		return c.json({ success: false, message: 'Workspace administrator access is required' }, 403);
	}
	let interval;
	try {
		interval = normalizeWorkspaceBudgetInterval(c.req.param('interval'));
	} catch (error) {
		return c.json({ success: false, message: error instanceof Error ? error.message : 'Invalid interval' }, 400);
	}
	const workspaceId = c.get('workspaceContext').currentWorkspace.id;
	if (!(await deleteWorkspaceBudget(c.get('repositories').client, workspaceId, interval))) {
		return c.json({ success: false, message: 'Workspace not found' }, 404);
	}
	c.header('Cache-Control', 'private, no-store');
	return c.json({ success: true, deleted: true });
});
