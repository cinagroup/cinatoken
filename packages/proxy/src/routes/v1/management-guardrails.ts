import {
	assignManagementGuardrailKeys,
	assignManagementGuardrailMembers,
	createManagementGuardrail,
	deleteManagementGuardrail,
	getManagementGuardrail,
	getManagementWorkspace,
	listManagementGuardrailKeyAssignments,
	listManagementGuardrailMemberAssignments,
	listManagementGuardrails,
	MANAGEMENT_GUARDRAIL_ASSIGNMENT_MAX_BODY_BYTES,
	normalizeManagementGuardrailCreate,
	normalizeManagementGuardrailKeyAssignmentBody,
	normalizeManagementGuardrailMemberAssignmentBody,
	normalizeManagementGuardrailPatch,
	publicManagementGuardrail,
	MANAGEMENT_GUARDRAIL_MAX_BODY_BYTES,
	unassignManagementGuardrailKeys,
	unassignManagementGuardrailMembers,
	updateManagementGuardrail,
	type ManagementApiKeyAccount,
	type ManagementApiKeyPrincipal,
	type ManagementGuardrailMutationPrincipal,
} from '@octafuse/core';
import { Hono, type Context } from 'hono';
import type { Env } from '../../app';
import { requireStrictManagementApiKey } from '../../middleware/management-auth';
import {
	BoundedJsonRequestError,
	readBoundedJsonObject,
} from '../../services/egress/bounded-json-request';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';

type ManagementGuardrailsEnv = Env & {
	Variables: { managementKey: ManagementApiKeyPrincipal };
};

const MAX_PAGE_OFFSET = 1_000_000;
const MAX_WORKSPACE_REFERENCE_LENGTH = 128;

function account(principal: ManagementApiKeyPrincipal): ManagementApiKeyAccount {
	return {
		accountType: principal.accountType,
		personalOwnerUserId: principal.personalOwnerUserId,
		organizationId: principal.organizationId,
	};
}

function mutationPrincipal(
	principal: ManagementApiKeyPrincipal,
): ManagementGuardrailMutationPrincipal {
	return {
		keyId: principal.keyId,
		createdByUserId: principal.createdByUserId,
		account: account(principal),
	};
}

function invalid(c: Context<ManagementGuardrailsEnv>, message: string) {
	return gatewayErrorJson(c, {
		status: 400,
		code: GatewayErrorCode.invalidRequest,
		message,
	});
}

function notFound(c: Context<ManagementGuardrailsEnv>) {
	return gatewayErrorJson(c, {
		status: 404,
		code: GatewayErrorCode.routeNotFound,
		message: 'Resource not found',
	});
}

function forbidden(c: Context<ManagementGuardrailsEnv>, message: string) {
	return gatewayErrorJson(c, {
		status: 403,
		code: GatewayErrorCode.permissionDenied,
		message,
	});
}

function conflict(c: Context<ManagementGuardrailsEnv>) {
	return gatewayErrorJson(c, {
		status: 409,
		code: GatewayErrorCode.invalidRequest,
		message: 'Guardrail was modified by another request; fetch it and retry',
	});
}

function boundedBodyError(c: Context<ManagementGuardrailsEnv>, error: unknown) {
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

function page(c: Context<ManagementGuardrailsEnv>) {
	return {
		offset: parseIntegerQuery(c.req.query('offset'), 'offset', 0),
		limit: parseIntegerQuery(c.req.query('limit'), 'limit', 50),
	};
}

function workspaceReference(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string') throw new TypeError('workspace_id must be a string');
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_WORKSPACE_REFERENCE_LENGTH) {
		throw new TypeError('workspace_id is invalid');
	}
	return normalized;
}

async function resolveWorkspace(
	c: Context<ManagementGuardrailsEnv>,
	principal: ManagementApiKeyPrincipal,
	reference: string | undefined,
) {
	return getManagementWorkspace(
		c.get('repositories').client,
		account(principal),
		reference ?? 'default',
	);
}

function mutationFailure(
	c: Context<ManagementGuardrailsEnv>,
	status: 'not_found' | 'conflict' | 'creator_unavailable',
) {
	if (status === 'conflict') return conflict(c);
	if (status === 'creator_unavailable') {
		return forbidden(c, 'Management key creator is unavailable');
	}
	return notFound(c);
}

export const managementGuardrailRoutes = new Hono<ManagementGuardrailsEnv>();

managementGuardrailRoutes.use('*', async (c, next) => {
	c.header('Cache-Control', 'private, no-store');
	await next();
});
managementGuardrailRoutes.use('*', requireStrictManagementApiKey);

managementGuardrailRoutes.get('/', async (c) => {
	try {
		const principal = c.get('managementKey');
		const workspace = await resolveWorkspace(
			c,
			principal,
			workspaceReference(c.req.query('workspace_id')),
		);
		if (!workspace) return notFound(c);
		const result = await listManagementGuardrails(
			c.get('repositories').client,
			account(principal),
			workspace.id,
			page(c),
		);
		return c.json({
			data: result.data.map(publicManagementGuardrail),
			total_count: result.totalCount,
		});
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.post('/', async (c) => {
	try {
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: MANAGEMENT_GUARDRAIL_MAX_BODY_BYTES,
			label: 'Guardrail request',
		});
		const principal = c.get('managementKey');
		const workspace = await resolveWorkspace(
			c,
			principal,
			workspaceReference(body.workspace_id),
		);
		if (!workspace) return notFound(c);
		const result = await createManagementGuardrail(
			c.get('repositories').client,
			mutationPrincipal(principal),
			normalizeManagementGuardrailCreate(body, workspace.id),
		);
		return result.status === 'ok'
			? c.json({ data: publicManagementGuardrail(result.row) }, 201)
			: mutationFailure(c, result.status);
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.get('/assignments/keys', async (c) => {
	try {
		const result = await listManagementGuardrailKeyAssignments(
			c.get('repositories').client,
			account(c.get('managementKey')),
			null,
			page(c),
		);
		return c.json({ data: result?.data ?? [], total_count: result?.totalCount ?? 0 });
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.get('/assignments/members', async (c) => {
	try {
		const result = await listManagementGuardrailMemberAssignments(
			c.get('repositories').client,
			account(c.get('managementKey')),
			null,
			page(c),
		);
		return c.json({ data: result?.data ?? [], total_count: result?.totalCount ?? 0 });
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.get('/:id/assignments/keys', async (c) => {
	try {
		const result = await listManagementGuardrailKeyAssignments(
			c.get('repositories').client,
			account(c.get('managementKey')),
			c.req.param('id'),
			page(c),
		);
		return result
			? c.json({ data: result.data, total_count: result.totalCount })
			: notFound(c);
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.post('/:id/assignments/keys/remove', async (c) => {
	try {
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: MANAGEMENT_GUARDRAIL_ASSIGNMENT_MAX_BODY_BYTES,
			label: 'Guardrail key assignment request',
		});
		const principal = c.get('managementKey');
		const result = await unassignManagementGuardrailKeys(
			c.get('repositories').client,
			mutationPrincipal(principal),
			c.req.param('id'),
			normalizeManagementGuardrailKeyAssignmentBody(body),
		);
		if (result.status === 'creator_unavailable') return forbidden(c, 'Management key creator is unavailable');
		return result.status === 'not_found' ? notFound(c) : c.json({ unassigned_count: result.count });
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.post('/:id/assignments/keys', async (c) => {
	try {
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: MANAGEMENT_GUARDRAIL_ASSIGNMENT_MAX_BODY_BYTES,
			label: 'Guardrail key assignment request',
		});
		const principal = c.get('managementKey');
		const result = await assignManagementGuardrailKeys(
			c.get('repositories').client,
			mutationPrincipal(principal),
			c.req.param('id'),
			normalizeManagementGuardrailKeyAssignmentBody(body),
		);
		if (result.status === 'creator_unavailable') return forbidden(c, 'Management key creator is unavailable');
		return result.status === 'not_found' ? notFound(c) : c.json({ assigned_count: result.count });
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.get('/:id/assignments/members', async (c) => {
	try {
		const result = await listManagementGuardrailMemberAssignments(
			c.get('repositories').client,
			account(c.get('managementKey')),
			c.req.param('id'),
			page(c),
		);
		return result
			? c.json({ data: result.data, total_count: result.totalCount })
			: notFound(c);
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.post('/:id/assignments/members/remove', async (c) => {
	try {
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: MANAGEMENT_GUARDRAIL_ASSIGNMENT_MAX_BODY_BYTES,
			label: 'Guardrail member assignment request',
		});
		const principal = c.get('managementKey');
		const result = await unassignManagementGuardrailMembers(
			c.get('repositories').client,
			mutationPrincipal(principal),
			c.req.param('id'),
			normalizeManagementGuardrailMemberAssignmentBody(body),
		);
		if (result.status === 'creator_unavailable') return forbidden(c, 'Management key creator is unavailable');
		return result.status === 'not_found' ? notFound(c) : c.json({ unassigned_count: result.count });
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.post('/:id/assignments/members', async (c) => {
	try {
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: MANAGEMENT_GUARDRAIL_ASSIGNMENT_MAX_BODY_BYTES,
			label: 'Guardrail member assignment request',
		});
		const principal = c.get('managementKey');
		const result = await assignManagementGuardrailMembers(
			c.get('repositories').client,
			mutationPrincipal(principal),
			c.req.param('id'),
			normalizeManagementGuardrailMemberAssignmentBody(body),
		);
		if (result.status === 'creator_unavailable') return forbidden(c, 'Management key creator is unavailable');
		return result.status === 'not_found' ? notFound(c) : c.json({ assigned_count: result.count });
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.get('/:id', async (c) => {
	try {
		const principal = c.get('managementKey');
		const row = await getManagementGuardrail(
			c.get('repositories').client,
			account(principal),
			c.req.param('id'),
		);
		return row ? c.json({ data: publicManagementGuardrail(row) }) : notFound(c);
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.patch('/:id', async (c) => {
	try {
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: MANAGEMENT_GUARDRAIL_MAX_BODY_BYTES,
			label: 'Guardrail request',
		});
		const principal = c.get('managementKey');
		const current = await getManagementGuardrail(
			c.get('repositories').client,
			account(principal),
			c.req.param('id'),
		);
		if (!current) return notFound(c);
		const result = await updateManagementGuardrail(
			c.get('repositories').client,
			mutationPrincipal(principal),
			current.id,
			normalizeManagementGuardrailPatch(body, current),
		);
		return result.status === 'ok'
			? c.json({ data: publicManagementGuardrail(result.row) })
			: mutationFailure(c, result.status);
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

managementGuardrailRoutes.delete('/:id', async (c) => {
	try {
		const principal = c.get('managementKey');
		const result = await deleteManagementGuardrail(
			c.get('repositories').client,
			mutationPrincipal(principal),
			c.req.param('id'),
		);
		if (result === 'deleted') return c.json({ deleted: true });
		if (result === 'creator_unavailable') {
			return forbidden(c, 'Management key creator is unavailable');
		}
		return notFound(c);
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});
