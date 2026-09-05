import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type {
	ByokKeyInsertParams,
	ByokKeyReorderParams,
	ByokKeyRow,
	ByokKeyUpdateParams,
	GatewayRepositories,
	WorkspaceAccessProjection,
} from '@octafuse/core';
import { isByokPortalUserPrincipal } from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';
import { getAccountCapabilities } from '@/lib/unified-session';
import { userByokRoutes } from '@/lib/routes/user/byok';

const workspace: WorkspaceAccessProjection = {
	id: 'personal:user-1',
	name: 'Personal',
	slug: 'personal',
	description: null,
	scopeType: 'personal',
	organizationId: null,
	organizationName: null,
	organizationSlug: null,
	personalOwnerUserId: 'user-1',
	isDefault: true,
	status: 'active',
	role: 'owner',
	accessSource: 'personal_owner',
	createdAt: '2026-09-03T00:00:00.000Z',
	updatedAt: '2026-09-03T00:00:00.000Z',
};

const row: ByokKeyRow = {
	id: '11111111-1111-4111-8111-111111111111',
	workspace_id: workspace.id,
	provider: 'deepseek',
	name: 'Production',
	label: '...cret',
	disabled: false,
	is_fallback: false,
	always_use_for_provider: true,
	always_use_for_matching_models: false,
	sort_order: 0,
	allowed_models: null,
	allowed_user_ids: null,
	allowed_api_key_hashes: null,
	created_by_management_key_id: null,
	created_at: '2026-09-03T00:00:00.000Z',
	updated_at: '2026-09-03T00:00:00.000Z',
};

function fixture(
	currentWorkspace: WorkspaceAccessProjection = workspace,
	organizationRoles = '',
) {
	let inserted: ByokKeyInsertParams | null = null;
	let updated: ByokKeyUpdateParams | null = null;
	let reordered: ByokKeyReorderParams | null = null;
	let deletedPrincipal: unknown = null;
	const repositories = {
		byokKeys: {
			listForAccount: async (_account: unknown, options: { workspaceId?: string }) => {
				assert.equal(options.workspaceId, currentWorkspace.id);
				return { data: [{ ...row, workspace_id: currentWorkspace.id }], totalCount: 1 };
			},
			getByIdInAccount: async () => ({ ...row, workspace_id: currentWorkspace.id }),
			insertForManagement: async (params: ByokKeyInsertParams) => {
				inserted = params;
				return { ...row, id: params.id, workspace_id: params.input.workspaceId };
			},
			updateForManagement: async (params: ByokKeyUpdateParams) => {
				updated = params;
				return { ...row, workspace_id: currentWorkspace.id };
			},
			reorderForManagement: async (params: ByokKeyReorderParams) => {
				reordered = params;
				return 'updated' as const;
			},
			deleteForManagement: async (params: { principal: unknown }) => {
				deletedPrincipal = params.principal;
				return true;
			},
		},
		apiKeys: {
			getByHashForManagement: async () => ({ id: 'gateway-key-1' }),
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.use('*', async (c, next) => {
		c.env = { CINAAUTH_ORGANIZATION_ADMIN_ROLES: organizationRoles };
		c.set('repositories', repositories);
		c.set('principal', {
			userId: 'user-1',
			subject: 'subject-1',
			email: 'user@example.com',
			isAdmin: false,
			capabilities: getAccountCapabilities(false),
		});
		c.set('workspaceContext', {
			workspaces: [currentWorkspace],
			currentWorkspace,
			preferredWorkspaceAvailable: true,
		});
		await next();
	});
	app.route('/byok', userByokRoutes);
	return {
		app,
		getInserted: () => inserted,
		getUpdated: () => updated,
		getReordered: () => reordered,
		getDeletedPrincipal: () => deletedPrincipal,
	};
}

test('personal owner manages BYOK through a workspace-pinned portal principal without exposing the secret', async () => {
	const { app, getInserted, getUpdated, getReordered, getDeletedPrincipal } = fixture();
	const list = await app.request('/byok?limit=50');
	assert.equal(list.status, 200);
	assert.equal(list.headers.get('cache-control'), 'private, no-store');
	assert.doesNotMatch(await list.clone().text(), /provider-secret/u);

	const created = await app.request('/byok', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			workspace_id: workspace.id,
			provider: 'deepseek',
			name: 'Production',
			key: 'provider-secret',
			always_use_for_matching_models: true,
		}),
	});
	assert.equal(created.status, 201);
	assert.doesNotMatch(await created.text(), /provider-secret/u);
	const insert = getInserted();
	assert.ok(insert);
	assert.ok(isByokPortalUserPrincipal(insert.principal));
	assert.equal(insert.principal.principalType, 'portal_user');
	assert.equal(insert.principal.workspaceId, workspace.id);
	assert.equal(insert.principal.userId, 'user-1');
	assert.equal(insert.input.apiKey, 'provider-secret');
	assert.equal(insert.input.alwaysUseForProvider, false);
	assert.equal(insert.input.alwaysUseForMatchingModels, true);

	assert.equal((await app.request(`/byok/${row.id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ disabled: true }),
	})).status, 200);
	const update = getUpdated();
	assert.ok(update);
	assert.ok(isByokPortalUserPrincipal(update.principal));
	assert.equal(update.principal.principalType, 'portal_user');

	assert.equal((await app.request('/byok/reorder', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			workspace_id: workspace.id,
			provider: 'deepseek',
			keys: [{ id: row.id, is_fallback: false }],
		}),
	})).status, 200);
	const reorder = getReordered();
	assert.ok(reorder);
	assert.ok(isByokPortalUserPrincipal(reorder.principal));
	assert.equal(reorder.principal.principalType, 'portal_user');

	assert.equal((await app.request(`/byok/${row.id}`, { method: 'DELETE' })).status, 200);
	assert.deepEqual(getDeletedPrincipal(), insert.principal);
});

test('portal rejects a browser-supplied workspace outside the selected context', async () => {
	const { app, getInserted } = fixture();
	const response = await app.request('/byok', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			workspace_id: 'personal:user-2',
			provider: 'deepseek',
			key: 'provider-secret',
		}),
	});
	assert.equal(response.status, 404);
	assert.equal(getInserted(), null);
});

test('portal rejects oversized BYOK bodies before JSON materialization', async () => {
	const { app, getInserted } = fixture();
	const response = await app.request('/byok', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			provider: 'deepseek',
			key: 'x'.repeat(192 * 1024),
		}),
	});
	assert.equal(response.status, 413);
	assert.equal(getInserted(), null);
});

test('organization member is denied while an explicitly mapped CinaAuth administrator is allowed', async () => {
	const organizationWorkspace: WorkspaceAccessProjection = {
		...workspace,
		id: 'organization:org-1',
		name: 'Example Org',
		scopeType: 'organization',
		organizationId: 'org-1',
		organizationName: 'Example Org',
		organizationSlug: 'example-org',
		personalOwnerUserId: null,
		role: 'member',
		accessSource: 'organization_default',
		organizationRoles: ['billing-admin'],
	};
	assert.equal((await fixture(organizationWorkspace).app.request('/byok')).status, 403);
	assert.equal((await fixture(organizationWorkspace, 'billing-admin').app.request('/byok')).status, 200);
});
