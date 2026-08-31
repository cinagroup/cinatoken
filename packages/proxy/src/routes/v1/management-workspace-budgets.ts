import {
	deleteWorkspaceBudget,
	listWorkspaceBudgets,
	normalizeWorkspaceBudgetInterval,
	normalizeWorkspaceBudgetLimitMicros,
	resolveWorkspaceSlugForManagementAccount,
	upsertWorkspaceBudget,
	workspaceBudgetAmount,
	type ManagementApiKeyAccount,
	type ManagementApiKeyPrincipal,
	type WorkspaceBudgetRow,
} from '@octafuse/core';
import { Hono, type Context } from 'hono';
import type { Env } from '../../app';
import { requireManagementApiKey } from '../../middleware/management-auth';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';

type ManagementWorkspaceBudgetsEnv = Env & {
	Variables: { managementKey: ManagementApiKeyPrincipal };
};

const UPDATE_FIELDS = new Set(['limit_usd']);

function account(principal: ManagementApiKeyPrincipal): ManagementApiKeyAccount {
	return {
		accountType: principal.accountType,
		personalOwnerUserId: principal.personalOwnerUserId,
		organizationId: principal.organizationId,
	};
}

function invalid(c: Context<ManagementWorkspaceBudgetsEnv>, message: string) {
	return gatewayErrorJson(c, {
		status: 400,
		code: GatewayErrorCode.invalidRequest,
		message,
	});
}

function notFound(c: Context<ManagementWorkspaceBudgetsEnv>) {
	return gatewayErrorJson(c, {
		status: 404,
		code: GatewayErrorCode.routeNotFound,
		message: 'Resource not found',
	});
}

function publicBudget(row: WorkspaceBudgetRow) {
	return {
		id: row.id,
		workspace_id: row.workspace_id,
		limit_usd: workspaceBudgetAmount(row.limit_micros),
		reset_interval: row.reset_interval,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

async function resolveWorkspaceId(
	c: Context<ManagementWorkspaceBudgetsEnv>,
): Promise<string | null> {
	const identifier = (c.req.param('id_or_slug') ?? '').trim();
	if (!identifier || identifier.length > 600) return null;
	const principal = c.get('managementKey');
	const repositories = c.get('repositories');
	const owner = account(principal);
	if (await repositories.managementApiKeys.workspaceBelongsToAccount(identifier, owner)) {
		return identifier;
	}
	return resolveWorkspaceSlugForManagementAccount(
		repositories.client,
		identifier,
		owner,
	);
}

export const managementWorkspaceBudgetRoutes = new Hono<ManagementWorkspaceBudgetsEnv>();

managementWorkspaceBudgetRoutes.use('*', requireManagementApiKey);

managementWorkspaceBudgetRoutes.get('/:id_or_slug/budgets', async (c) => {
	const workspaceId = await resolveWorkspaceId(c);
	if (!workspaceId) return notFound(c);
	const rows = await listWorkspaceBudgets(c.get('repositories').client, workspaceId);
	c.header('Cache-Control', 'private, no-store');
	return c.json({ data: rows.map(publicBudget) });
});

managementWorkspaceBudgetRoutes.put('/:id_or_slug/budgets/:interval', async (c) => {
	let interval;
	try {
		interval = normalizeWorkspaceBudgetInterval(c.req.param('interval'));
	} catch (error) {
		return invalid(c, error instanceof Error ? error.message : 'Invalid budget interval');
	}
	const workspaceId = await resolveWorkspaceId(c);
	if (!workspaceId) return notFound(c);
	const body = await c.req.json<unknown>().catch(() => null);
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return invalid(c, 'Invalid JSON body');
	}
	const fields = Object.keys(body);
	if (fields.length !== 1 || !fields.every((field) => UPDATE_FIELDS.has(field))) {
		return invalid(c, 'limit_usd is the only supported field');
	}
	let limitMicros: number;
	try {
		limitMicros = normalizeWorkspaceBudgetLimitMicros(
			(body as Record<string, unknown>).limit_usd,
		);
	} catch (error) {
		return invalid(c, error instanceof Error ? error.message : 'Invalid budget limit');
	}
	try {
		const row = await upsertWorkspaceBudget(c.get('repositories').client, {
			workspaceId,
			interval,
			limitMicros,
		});
		if (!row) return notFound(c);
		c.header('Cache-Control', 'private, no-store');
		return c.json({ data: publicBudget(row) });
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementWorkspaceBudgetRoutes.delete('/:id_or_slug/budgets/:interval', async (c) => {
	let interval;
	try {
		interval = normalizeWorkspaceBudgetInterval(c.req.param('interval'));
	} catch (error) {
		return invalid(c, error instanceof Error ? error.message : 'Invalid budget interval');
	}
	const workspaceId = await resolveWorkspaceId(c);
	if (!workspaceId) return notFound(c);
	if (!(await deleteWorkspaceBudget(c.get('repositories').client, workspaceId, interval))) {
		return notFound(c);
	}
	c.header('Cache-Control', 'private, no-store');
	return c.json({ deleted: true });
});
