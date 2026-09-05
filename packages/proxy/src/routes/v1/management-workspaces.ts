import {
	addManagementWorkspaceMembers,
	createManagementWorkspace,
	deleteManagementWorkspace,
	getManagementWorkspace,
	listManagementWorkspaceMembers,
	listManagementWorkspaces,
	normalizeManagementWorkspaceCreate,
	normalizeManagementWorkspaceMemberIds,
	normalizeManagementWorkspacePatch,
	parseManagementWorkspaceAdminRoles,
	publicManagementWorkspace,
	removeManagementWorkspaceMembers,
	updateManagementWorkspace,
	type ManagementApiKeyAccount,
	type ManagementApiKeyPrincipal,
	type ManagementWorkspaceMemberMutationResult,
	type ManagementWorkspaceMutationPrincipal,
} from '@octafuse/core';
import { Hono, type Context } from 'hono';
import type { Env } from '../../app';
import { requireManagementApiKey } from '../../middleware/management-auth';
import {
	BoundedJsonRequestError,
	readBoundedJsonObject,
} from '../../services/egress/bounded-json-request';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';

type ManagementWorkspacesEnv = Env & {
	Variables: { managementKey: ManagementApiKeyPrincipal };
};

const MAX_WORKSPACE_BODY_BYTES = 32 * 1024;
const MAX_MEMBER_BODY_BYTES = 64 * 1024;
const MAX_PAGE_OFFSET = 1_000_000;

function account(principal: ManagementApiKeyPrincipal): ManagementApiKeyAccount {
	return {
		accountType: principal.accountType,
		personalOwnerUserId: principal.personalOwnerUserId,
		organizationId: principal.organizationId,
	};
}

function mutationPrincipal(
	principal: ManagementApiKeyPrincipal,
): ManagementWorkspaceMutationPrincipal {
	return {
		keyId: principal.keyId,
		createdByUserId: principal.createdByUserId,
		account: account(principal),
	};
}

function invalid(c: Context<ManagementWorkspacesEnv>, message: string) {
	return gatewayErrorJson(c, {
		status: 400,
		code: GatewayErrorCode.invalidRequest,
		message,
	});
}

function notFound(c: Context<ManagementWorkspacesEnv>) {
	return gatewayErrorJson(c, {
		status: 404,
		code: GatewayErrorCode.routeNotFound,
		message: 'Resource not found',
	});
}

function boundedBodyError(c: Context<ManagementWorkspacesEnv>, error: unknown) {
	if (!(error instanceof BoundedJsonRequestError)) return null;
	return gatewayErrorJson(c, {
		status: error.kind === 'payload_too_large' ? 413 : 400,
		code: error.kind === 'payload_too_large'
			? GatewayErrorCode.payloadTooLarge
			: error.kind === 'invalid_json'
				? GatewayErrorCode.invalidJson
				: GatewayErrorCode.invalidRequest,
		message: error.message,
	});
}

function parseIntegerQuery(
	raw: string | undefined,
	field: 'offset' | 'limit',
	fallback: number,
): number {
	if (raw === undefined) return fallback;
	if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new TypeError(`${field} must be an integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be an integer`);
	if (field === 'offset' && value > MAX_PAGE_OFFSET) {
		throw new TypeError(`offset must be no greater than ${MAX_PAGE_OFFSET}`);
	}
	if (field === 'limit' && (value < 1 || value > 100)) {
		throw new TypeError('limit must be between 1 and 100');
	}
	return value;
}

function page(c: Context<ManagementWorkspacesEnv>) {
	return {
		offset: parseIntegerQuery(c.req.query('offset'), 'offset', 0),
		limit: parseIntegerQuery(c.req.query('limit'), 'limit', 50),
	};
}

function publicMember(row: {
	id: string;
	workspace_id: string;
	user_id: string;
	role: string;
	created_at: string;
}) {
	return {
		created_at: row.created_at,
		id: row.id,
		role: row.role,
		user_id: row.user_id,
		workspace_id: row.workspace_id,
	};
}

function memberMutationError(
	c: Context<ManagementWorkspacesEnv>,
	result: Exclude<ManagementWorkspaceMemberMutationResult, { ok: true }>,
) {
	if (result.reason === 'not_found') return notFound(c);
	const messages = {
		active_keys: 'Members with active API keys in this workspace cannot be removed',
		default_workspace: 'Default workspace membership is managed through organization membership',
		personal_workspace: 'Workspace membership changes require an organization account',
		unknown_members: 'Every user_id must identify an active member of this organization',
	} as const;
	return invalid(c, messages[result.reason]);
}

async function memberIds(c: Context<ManagementWorkspacesEnv>): Promise<string[]> {
	const body = await readBoundedJsonObject(c.req.raw, {
		maxBytes: MAX_MEMBER_BODY_BYTES,
		label: 'Workspace member request',
	});
	const fields = Object.keys(body);
	if (fields.length !== 1 || fields[0] !== 'user_ids') {
		throw new TypeError('user_ids is the only supported field');
	}
	return normalizeManagementWorkspaceMemberIds(body.user_ids);
}

export const managementWorkspaceRoutes = new Hono<ManagementWorkspacesEnv>();

managementWorkspaceRoutes.use('*', async (c, next) => {
	c.header('Cache-Control', 'private, no-store');
	await next();
});
managementWorkspaceRoutes.use('*', requireManagementApiKey);

managementWorkspaceRoutes.get('/', async (c) => {
	try {
		const principal = c.get('managementKey');
		const result = await listManagementWorkspaces(
			c.get('repositories').client,
			account(principal),
			page(c),
		);
		return c.json({
			data: result.data.map(publicManagementWorkspace),
			total_count: result.totalCount,
		});
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementWorkspaceRoutes.post('/', async (c) => {
	try {
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: MAX_WORKSPACE_BODY_BYTES,
			label: 'Workspace request',
		});
		const principal = c.get('managementKey');
		const row = await createManagementWorkspace(
			c.get('repositories').client,
			mutationPrincipal(principal),
			normalizeManagementWorkspaceCreate(body),
		);
		return row ? c.json({ data: publicManagementWorkspace(row) }, 201) : notFound(c);
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementWorkspaceRoutes.get('/:id_or_slug', async (c) => {
	try {
		const principal = c.get('managementKey');
		const row = await getManagementWorkspace(
			c.get('repositories').client,
			account(principal),
			c.req.param('id_or_slug'),
		);
		return row ? c.json({ data: publicManagementWorkspace(row) }) : notFound(c);
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementWorkspaceRoutes.patch('/:id_or_slug', async (c) => {
	try {
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: MAX_WORKSPACE_BODY_BYTES,
			label: 'Workspace request',
		});
		const principal = c.get('managementKey');
		const row = await updateManagementWorkspace(
			c.get('repositories').client,
			mutationPrincipal(principal),
			c.req.param('id_or_slug'),
			normalizeManagementWorkspacePatch(body),
		);
		return row ? c.json({ data: publicManagementWorkspace(row) }) : notFound(c);
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementWorkspaceRoutes.delete('/:id_or_slug', async (c) => {
	const rawConfirmation = c.req.query('confirm_default_workspace_deletion');
	if (rawConfirmation !== undefined && rawConfirmation !== 'true' && rawConfirmation !== 'false') {
		return invalid(c, 'confirm_default_workspace_deletion must be true or false');
	}
	try {
		const principal = c.get('managementKey');
		const result = await deleteManagementWorkspace(
			c.get('repositories').client,
			mutationPrincipal(principal),
			c.req.param('id_or_slug'),
			rawConfirmation === 'true',
		);
		if (result === 'not_found') return notFound(c);
		if (result === 'active_keys') {
			return invalid(c, 'A workspace with active API keys cannot be deleted');
		}
		if (result === 'account_default_anchor') {
			return invalid(c, 'The last workspace anchoring the Account Default Guardrail cannot be deleted');
		}
		if (result === 'confirmation_required') {
			return invalid(c, 'Deleting the default workspace requires confirm_default_workspace_deletion=true');
		}
		return c.json({ deleted: true });
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementWorkspaceRoutes.get('/:id_or_slug/members', async (c) => {
	try {
		const principal = c.get('managementKey');
		const result = await listManagementWorkspaceMembers(
			c.get('repositories').client,
			account(principal),
			c.req.param('id_or_slug'),
			page(c),
			parseManagementWorkspaceAdminRoles(c.get('organizationAdminRoles')),
		);
		return result
			? c.json({ data: result.data.map(publicMember), total_count: result.totalCount })
			: notFound(c);
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementWorkspaceRoutes.post('/:id_or_slug/members/add', async (c) => {
	try {
		const principal = c.get('managementKey');
		const result = await addManagementWorkspaceMembers(
			c.get('repositories').client,
			mutationPrincipal(principal),
			c.req.param('id_or_slug'),
			await memberIds(c),
			parseManagementWorkspaceAdminRoles(c.get('organizationAdminRoles')),
		);
		return result.ok
			? c.json({ added_count: result.changedCount, data: result.data.map(publicMember) })
			: memberMutationError(c, result);
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementWorkspaceRoutes.post('/:id_or_slug/members/remove', async (c) => {
	try {
		const principal = c.get('managementKey');
		const result = await removeManagementWorkspaceMembers(
			c.get('repositories').client,
			mutationPrincipal(principal),
			c.req.param('id_or_slug'),
			await memberIds(c),
		);
		return result.ok
			? c.json({ removed_count: result.changedCount })
			: memberMutationError(c, result);
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});
