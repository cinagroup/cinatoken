import { Hono, type Context } from 'hono';
import {
	byokAccountFromPrincipal,
	normalizeByokKeyCreate,
	normalizeByokKeyPatch,
	normalizeByokKeyReorder,
	normalizeByokProvider,
	publicByokKey,
	type ByokPortalUserPrincipal,
	type ManagementApiKeyAccount,
} from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';
import { hasAuthoritativeOrganizationAdminRole } from '@/lib/cinaauth/organization-admin-roles';

const BYOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BYOK_MAX_BODY_BYTES = 192 * 1024;
const MAX_PAGE_OFFSET = 1_000_000;

class ByokBodyTooLargeError extends Error {
	constructor() {
		super('BYOK request body is too large');
		this.name = 'ByokBodyTooLargeError';
	}
}

export const userByokRoutes = new Hono<UserEnv>();

userByokRoutes.use('*', async (c, next) => {
	c.header('Cache-Control', 'private, no-store');
	await next();
});

function access(c: Context<UserEnv>): ByokPortalUserPrincipal | null {
	const principal = c.get('principal');
	const workspace = c.get('workspaceContext').currentWorkspace;
	if (workspace.scopeType === 'personal') {
		if (workspace.personalOwnerUserId !== principal.userId || workspace.role !== 'owner') return null;
		return {
			principalType: 'portal_user',
			accountType: 'personal',
			personalOwnerUserId: principal.userId,
			organizationId: null,
			userId: principal.userId,
			workspaceId: workspace.id,
		};
	}
	if (
		!workspace.organizationId
		|| !hasAuthoritativeOrganizationAdminRole(
			workspace,
			c.env?.CINAAUTH_ORGANIZATION_ADMIN_ROLES,
		)
	) return null;
	return {
		principalType: 'portal_user',
		accountType: 'organization',
		personalOwnerUserId: null,
		organizationId: workspace.organizationId,
		userId: principal.userId,
		workspaceId: workspace.id,
	};
}

function denied(c: Context<UserEnv>) {
	return c.json({
		success: false,
		message: 'BYOK credentials require personal ownership or organization administrator access',
	}, 403);
}

function notFound(c: Context<UserEnv>) {
	return c.json({ success: false, message: 'Not found' }, 404);
}

function invalid(c: Context<UserEnv>, error: unknown) {
	return c.json({
		success: false,
		message: error instanceof TypeError ? error.message : 'Invalid BYOK request',
	}, 400);
}

function tooLarge(c: Context<UserEnv>) {
	return c.json({ success: false, message: 'BYOK request body is too large' }, 413);
}

function parseInteger(raw: string | undefined, field: 'offset' | 'limit', fallback: number): number {
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

function keyId(c: Context<UserEnv>): string | null {
	const value = c.req.param('id')?.toLowerCase() ?? '';
	return BYOK_ID.test(value) ? value : null;
}

async function readBody(c: Context<UserEnv>): Promise<Record<string, unknown> | null> {
	const request = c.req.raw;
	const contentLength = request.headers.get('content-length');
	if (contentLength != null) {
		const declared = Number(contentLength);
		if (!Number.isSafeInteger(declared) || declared < 0 || declared > BYOK_MAX_BODY_BYTES) {
			await request.body?.cancel('byok_body_too_large').catch(() => undefined);
			throw new ByokBodyTooLargeError();
		}
	}
	if (!request.body) return null;

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > BYOK_MAX_BODY_BYTES) {
				await reader.cancel('byok_body_too_large').catch(() => undefined);
				throw new ByokBodyTooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	const value = (() => {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return null;
		}
	})();
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

async function hashesBelongToAccount(
	c: Context<UserEnv>,
	account: ManagementApiKeyAccount,
	hashes: string[] | null | undefined,
): Promise<boolean> {
	if (hashes == null) return true;
	for (let offset = 0; offset < hashes.length; offset += 4) {
		const rows = await Promise.all(hashes.slice(offset, offset + 4).map((hash) =>
			c.get('repositories').apiKeys.getByHashForManagement({
				...account,
				keyHash: `sha256:${hash}`,
			}),
		));
		if (rows.some((row) => row === null)) return false;
	}
	return true;
}

userByokRoutes.get('/', async (c) => {
	const principal = access(c);
	if (!principal) return denied(c);
	try {
		const providerRaw = c.req.query('provider');
		const result = await c.get('repositories').byokKeys.listForAccount(
			byokAccountFromPrincipal(principal),
			{
				offset: parseInteger(c.req.query('offset'), 'offset', 0),
				limit: parseInteger(c.req.query('limit'), 'limit', 50),
				workspaceId: principal.workspaceId,
				...(providerRaw === undefined ? {} : { provider: normalizeByokProvider(providerRaw) }),
			},
		);
		return c.json({
			success: true,
			data: result.data.map(publicByokKey),
			total: result.totalCount,
			workspaceId: principal.workspaceId,
		});
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error);
		throw error;
	}
});

userByokRoutes.post('/', async (c) => {
	const principal = access(c);
	if (!principal) return denied(c);
	try {
		const body = await readBody(c);
		if (!body) return invalid(c, new TypeError('Invalid JSON body'));
		const input = normalizeByokKeyCreate(body, principal.workspaceId);
		if (input.workspaceId !== principal.workspaceId) return notFound(c);
		const account = byokAccountFromPrincipal(principal);
		if (!(await hashesBelongToAccount(c, account, input.allowedApiKeyHashes))) {
			return invalid(c, new TypeError('Every allowed_api_key_hashes item must belong to this account'));
		}
		const row = await c.get('repositories').byokKeys.insertForManagement({
			principal,
			id: crypto.randomUUID(),
			input,
			nowIso: new Date().toISOString(),
		});
		return row
			? c.json({ success: true, data: publicByokKey(row) }, 201)
			: notFound(c);
	} catch (error) {
		if (error instanceof ByokBodyTooLargeError) return tooLarge(c);
		if (error instanceof TypeError) return invalid(c, error);
		throw error;
	}
});

userByokRoutes.post('/reorder', async (c) => {
	const principal = access(c);
	if (!principal) return denied(c);
	try {
		const body = await readBody(c);
		if (!body) return invalid(c, new TypeError('Invalid JSON body'));
		const input = normalizeByokKeyReorder(body, principal.workspaceId);
		if (input.workspaceId !== principal.workspaceId) return notFound(c);
		const result = await c.get('repositories').byokKeys.reorderForManagement({
			principal,
			input,
			nowIso: new Date().toISOString(),
		});
		if (result === 'not_found') return notFound(c);
		if (result === 'conflict') {
			return c.json({
				success: false,
				message: 'BYOK credentials changed; reload the complete provider list and retry',
			}, 409);
		}
		return c.json({
			success: true,
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
		if (error instanceof ByokBodyTooLargeError) return tooLarge(c);
		if (error instanceof TypeError) return invalid(c, error);
		throw error;
	}
});

userByokRoutes.get('/:id', async (c) => {
	const principal = access(c);
	if (!principal) return denied(c);
	const id = keyId(c);
	if (!id) return notFound(c);
	const row = await c.get('repositories').byokKeys.getByIdInAccount(
		id,
		byokAccountFromPrincipal(principal),
	);
	return row?.workspace_id === principal.workspaceId
		? c.json({ success: true, data: publicByokKey(row) })
		: notFound(c);
});

userByokRoutes.patch('/:id', async (c) => {
	const principal = access(c);
	if (!principal) return denied(c);
	const id = keyId(c);
	if (!id) return notFound(c);
	try {
		const body = await readBody(c);
		if (!body) return invalid(c, new TypeError('Invalid JSON body'));
		const patch = normalizeByokKeyPatch(body);
		const account = byokAccountFromPrincipal(principal);
		if (!(await hashesBelongToAccount(c, account, patch.allowedApiKeyHashes))) {
			return invalid(c, new TypeError('Every allowed_api_key_hashes item must belong to this account'));
		}
		const row = await c.get('repositories').byokKeys.updateForManagement({
			principal,
			id,
			patch,
			nowIso: new Date().toISOString(),
		});
		return row?.workspace_id === principal.workspaceId
			? c.json({ success: true, data: publicByokKey(row) })
			: notFound(c);
	} catch (error) {
		if (error instanceof ByokBodyTooLargeError) return tooLarge(c);
		if (error instanceof TypeError) return invalid(c, error);
		throw error;
	}
});

userByokRoutes.delete('/:id', async (c) => {
	const principal = access(c);
	if (!principal) return denied(c);
	const id = keyId(c);
	if (!id) return notFound(c);
	const deleted = await c.get('repositories').byokKeys.deleteForManagement({
		principal,
		id,
		nowIso: new Date().toISOString(),
	});
	return deleted ? c.json({ success: true, deleted: true }) : notFound(c);
});
