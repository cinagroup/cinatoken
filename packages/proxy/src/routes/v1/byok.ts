import {
	byokAccountFromPrincipal,
	defaultWorkspaceId,
	normalizeByokKeyCreate,
	normalizeByokKeyPatch,
	normalizeByokKeyReorder,
	normalizeByokProvider,
	normalizeByokWorkspaceId,
	publicByokKey,
	type ManagementApiKeyPrincipal,
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

type ByokRoutesEnv = Env & {
	Variables: { managementKey: ManagementApiKeyPrincipal };
};

const BYOK_MAX_BODY_BYTES = 192 * 1024;
const MAX_PAGE_OFFSET = 1_000_000;
const BYOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function invalid(c: Context<ByokRoutesEnv>, message: string) {
	return gatewayErrorJson(c, {
		status: 400,
		code: GatewayErrorCode.invalidRequest,
		message,
	});
}

function notFound(c: Context<ByokRoutesEnv>) {
	return gatewayErrorJson(c, {
		status: 404,
		code: GatewayErrorCode.routeNotFound,
		message: 'Resource not found',
	});
}

function conflict(c: Context<ByokRoutesEnv>) {
	return gatewayErrorJson(c, {
		status: 409,
		code: GatewayErrorCode.resourceConflict,
		message: 'BYOK keys changed; fetch the complete provider list and retry',
	});
}

function boundedBodyError(c: Context<ByokRoutesEnv>, error: unknown) {
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

function defaultWorkspace(principal: ManagementApiKeyPrincipal): string {
	const owner = principal.accountType === 'personal'
		? principal.personalOwnerUserId
		: principal.organizationId;
	if (!owner) throw new TypeError('Management API key account is invalid');
	return defaultWorkspaceId(principal.accountType, owner);
}

async function hashesBelongToAccount(
	c: Context<ByokRoutesEnv>,
	principal: ManagementApiKeyPrincipal,
	hashes: string[] | null | undefined,
): Promise<boolean> {
	if (hashes == null) return true;
	const repositories = c.get('repositories');
	const account = byokAccountFromPrincipal(principal);
	// Keep D1 concurrent queries below its connection limit while retaining a
	// bounded validation path for the OpenRouter-compatible 100-item maximum.
	for (let offset = 0; offset < hashes.length; offset += 4) {
		const rows = await Promise.all(hashes.slice(offset, offset + 4).map((hash) =>
			repositories.apiKeys.getByHashForManagement({
				...account,
				keyHash: `sha256:${hash}`,
			}),
		));
		if (rows.some((row) => row === null)) return false;
	}
	return true;
}

function id(c: Context<ByokRoutesEnv>): string | null {
	const value = c.req.param('id')?.toLowerCase() ?? '';
	return BYOK_ID.test(value) ? value : null;
}

export const byokRoutes = new Hono<ByokRoutesEnv>();

byokRoutes.use('*', async (c, next) => {
	c.header('Cache-Control', 'private, no-store');
	await next();
});
byokRoutes.use('*', requireManagementApiKey);

byokRoutes.get('/', async (c) => {
	try {
		const principal = c.get('managementKey');
		const workspaceRaw = c.req.query('workspace_id');
		const providerRaw = c.req.query('provider');
		const workspaceId = workspaceRaw === undefined
			? defaultWorkspace(principal)
			: normalizeByokWorkspaceId(workspaceRaw);
		const repositories = c.get('repositories');
		const ownsWorkspace = await repositories.managementApiKeys.workspaceBelongsToAccount(
			workspaceId,
			byokAccountFromPrincipal(principal),
		);
		if (!ownsWorkspace) {
			return workspaceRaw === undefined
				? invalid(c, 'The default workspace is unavailable; pass workspace_id explicitly')
				: notFound(c);
		}
		const result = await repositories.byokKeys.listForAccount(
			byokAccountFromPrincipal(principal),
			{
				offset: parseIntegerQuery(c.req.query('offset'), 'offset', 0),
				limit: parseIntegerQuery(c.req.query('limit'), 'limit', 50),
				workspaceId,
				...(providerRaw === undefined
					? {}
					: { provider: normalizeByokProvider(providerRaw) }),
			},
		);
		return c.json({
			data: result.data.map(publicByokKey),
			total_count: result.totalCount,
		});
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

byokRoutes.post('/', async (c) => {
	try {
		const principal = c.get('managementKey');
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: BYOK_MAX_BODY_BYTES,
			label: 'BYOK request',
		});
		const input = normalizeByokKeyCreate(body, defaultWorkspace(principal));
		const repositories = c.get('repositories');
		const ownsWorkspace = await repositories.managementApiKeys.workspaceBelongsToAccount(
			input.workspaceId,
			byokAccountFromPrincipal(principal),
		);
		if (!ownsWorkspace) {
			return body.workspace_id === undefined
				? invalid(c, 'The default workspace is unavailable; pass workspace_id explicitly')
				: notFound(c);
		}
		if (!(await hashesBelongToAccount(c, principal, input.allowedApiKeyHashes))) {
			return invalid(c, 'Every allowed_api_key_hashes item must belong to this account');
		}
		const row = await repositories.byokKeys.insertForManagement({
			principal,
			id: crypto.randomUUID(),
			input,
			nowIso: new Date().toISOString(),
		});
		return row ? c.json({ data: publicByokKey(row) }, 201) : notFound(c);
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

byokRoutes.post('/reorder', async (c) => {
	try {
		const principal = c.get('managementKey');
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: BYOK_MAX_BODY_BYTES,
			label: 'BYOK reorder request',
		});
		const input = normalizeByokKeyReorder(body, defaultWorkspace(principal));
		const repositories = c.get('repositories');
		const ownsWorkspace = await repositories.managementApiKeys.workspaceBelongsToAccount(
			input.workspaceId,
			byokAccountFromPrincipal(principal),
		);
		if (!ownsWorkspace) {
			return body.workspace_id === undefined
				? invalid(c, 'The default workspace is unavailable; pass workspace_id explicitly')
				: notFound(c);
		}
		const result = await repositories.byokKeys.reorderForManagement({
			principal,
			input,
			nowIso: new Date().toISOString(),
		});
		if (result === 'not_found') return notFound(c);
		if (result === 'conflict') return conflict(c);
		return c.json({
			data: {
				workspace_id: input.workspaceId,
				provider: input.provider,
				keys: input.keys.map((item, sortOrder) => ({
					id: item.id,
					is_fallback: item.isFallback,
					sort_order: sortOrder,
				})),
			},
		});
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

byokRoutes.get('/:id', async (c) => {
	const keyId = id(c);
	if (!keyId) return notFound(c);
	const row = await c.get('repositories').byokKeys.getByIdInAccount(
		keyId,
		byokAccountFromPrincipal(c.get('managementKey')),
	);
	return row ? c.json({ data: publicByokKey(row) }) : notFound(c);
});

byokRoutes.patch('/:id', async (c) => {
	const keyId = id(c);
	if (!keyId) return notFound(c);
	try {
		const body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: BYOK_MAX_BODY_BYTES,
			label: 'BYOK request',
		});
		const patch = normalizeByokKeyPatch(body);
		const principal = c.get('managementKey');
		if (!(await hashesBelongToAccount(c, principal, patch.allowedApiKeyHashes))) {
			return invalid(c, 'Every allowed_api_key_hashes item must belong to this account');
		}
		const row = await c.get('repositories').byokKeys.updateForManagement({
			principal,
			id: keyId,
			patch,
			nowIso: new Date().toISOString(),
		});
		return row ? c.json({ data: publicByokKey(row) }) : notFound(c);
	} catch (error) {
		const bodyFailure = boundedBodyError(c, error);
		if (bodyFailure) return bodyFailure;
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
});

byokRoutes.delete('/:id', async (c) => {
	const keyId = id(c);
	if (!keyId) return notFound(c);
	const deleted = await c.get('repositories').byokKeys.deleteForManagement({
		principal: c.get('managementKey'),
		id: keyId,
		nowIso: new Date().toISOString(),
	});
	return deleted ? c.json({ deleted: true }) : notFound(c);
});
