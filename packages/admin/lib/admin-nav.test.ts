import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADMIN_NAV_GROUPS, formatAdminDocumentTitle, matchAdminNavRoute } from './admin-nav';

describe('matchAdminNavRoute', () => {
	it('matches exact sidebar paths', () => {
		assert.equal(matchAdminNavRoute('/admin/simulator')?.nameKey, 'simulator');
		assert.equal(matchAdminNavRoute('/admin/endpoints')?.nameKey, 'endpoints');
		assert.equal(matchAdminNavRoute('/dashboard')?.nameKey, 'dashboard');
	});

	it('prefers the longest href so nested tools pages win', () => {
		assert.equal(matchAdminNavRoute('/admin/tools')?.nameKey, 'toolsConfig');
		assert.equal(matchAdminNavRoute('/admin/tools/invocations')?.nameKey, 'toolInvocations');
		assert.equal(matchAdminNavRoute('/admin/mcp')?.nameKey, 'mcpServers');
	});

	it('lists REST services, then MCP servers', () => {
		const tools = ADMIN_NAV_GROUPS.find((group) => group.groupKey === 'tools');
		assert.deepEqual(
			tools?.items.map((item) => item.nameKey),
			['toolsConfig', 'mcpServers', 'toolInvocations'],
		);
	});

	it('keeps request and audit logs in their own group, after users', () => {
		const keys = ADMIN_NAV_GROUPS.map((group) => group.groupKey);
		assert.equal(keys.indexOf('logs'), keys.indexOf('user') + 1);
		assert.deepEqual(
			ADMIN_NAV_GROUPS.find((group) => group.groupKey === 'logs')?.items.map((item) => item.nameKey),
			['requestLogs', 'auditLogs'],
		);
		assert.deepEqual(
			ADMIN_NAV_GROUPS.find((group) => group.groupKey === 'user')?.items.map((item) => item.nameKey),
			['users', 'apiKeys', 'sharedKeys'],
		);
	});

	it('keeps integration keys separate and includes CinaToken asset operations and maintenance', () => {
  assert.deepEqual(ADMIN_NAV_GROUPS.find(group=>group.groupKey==='integration')?.items.map(item=>item.nameKey),['adminApiKeys']);
  assert.deepEqual(ADMIN_NAV_GROUPS.find(group=>group.groupKey==='system')?.items.map(item=>item.nameKey),['withdrawals','nftMints','config','maintenance']);
  assert.equal(matchAdminNavRoute('/admin/maintenance')?.nameKey,'maintenance');
 });

	it('treats user detail as Users', () => {
		assert.equal(matchAdminNavRoute('/admin/users/abc-123')?.nameKey, 'users');
	});

	it('does not confuse analytics users with the Users page', () => {
		assert.equal(matchAdminNavRoute('/admin/analytics/users')?.nameKey, 'userUsage');
	});

	it('returns null for unknown paths', () => {
		assert.equal(matchAdminNavRoute('/'), null);
		assert.equal(matchAdminNavRoute('/unknown'), null);
	});
});

describe('formatAdminDocumentTitle', () => {
	it('puts the page function before the product title', () => {
		assert.equal(
			formatAdminDocumentTitle('Simulator', 'cinatoken Gateway · Admin'),
			'Simulator · cinatoken Gateway · Admin',
		);
	});

	it('falls back to the product title when the page is unknown', () => {
		assert.equal(formatAdminDocumentTitle(null, 'cinatoken Gateway · Admin'), 'cinatoken Gateway · Admin');
		assert.equal(formatAdminDocumentTitle('  ', 'cinatoken Gateway · Admin'), 'cinatoken Gateway · Admin');
	});
});
