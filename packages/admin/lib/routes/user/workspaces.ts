import { Hono } from 'hono';
import type { UserEnv } from '@/lib/user-env';
import { workspaceCookieHeader } from '@/lib/workspace-cookie';

export const userWorkspacesRoutes = new Hono<UserEnv>();

/**
 * Lists only server-authorized Workspace contexts. Browser-provided ids are
 * never accepted as proof of membership.
 */
userWorkspacesRoutes.get('/', async (c) => {
	c.header('Cache-Control', 'private, no-store');
	return c.json({ success: true, data: c.get('workspaceContext') });
});

/**
 * Persists only a preference. The requested id is re-authorized against the
 * current CinaAuth membership projection before the HttpOnly cookie is set.
 */
userWorkspacesRoutes.put('/current', async (c) => {
	let body: { workspace_id?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, message: 'Invalid JSON body' }, 400);
	}
	if (typeof body.workspace_id !== 'string' || !body.workspace_id.trim() || body.workspace_id.length > 600) {
		return c.json({ success: false, message: 'workspace_id is invalid' }, 400);
	}
	const requestedWorkspaceId = body.workspace_id.trim();
	const requestContext = c.get('workspaceContext');
	const requestedWorkspace = requestContext.workspaces.find(
		(workspace) => workspace.id === requestedWorkspaceId,
	);
	if (!requestedWorkspace) {
		return c.json({ success: false, message: 'Workspace access denied' }, 403, {
			'Cache-Control': 'private, no-store',
		});
	}
	const context = {
		...requestContext,
		currentWorkspace: requestedWorkspace,
		preferredWorkspaceAvailable: true,
	};
	c.header('Set-Cookie', workspaceCookieHeader(requestedWorkspace.id, c.req.raw));
	c.header('Cache-Control', 'private, no-store');
	return c.json({ success: true, data: context });
});
