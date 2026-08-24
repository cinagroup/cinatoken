import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatAdminDocumentTitle, matchAdminNavRoute } from './admin-nav';

describe('matchAdminNavRoute', () => {
	it('matches exact sidebar paths', () => {
		assert.equal(matchAdminNavRoute('/admin/simulator')?.nameKey, 'simulator');
		assert.equal(matchAdminNavRoute('/dashboard')?.nameKey, 'dashboard');
	});

	it('prefers the longest href so nested tools pages win', () => {
		assert.equal(matchAdminNavRoute('/admin/tools')?.nameKey, 'toolsConfig');
		assert.equal(matchAdminNavRoute('/admin/tools/invocations')?.nameKey, 'toolInvocations');
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
