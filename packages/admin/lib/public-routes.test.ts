import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPublicProductPath } from './public-routes';

describe('isPublicProductPath', () => {
	it('publishes the implemented discovery pages and user portal', () => {
		for (const pathname of ['/', '/models', '/models/anthropic/claude', '/providers', '/compare', '/chat', '/rankings', '/benchmarks', '/account', '/account/settings']) {
			assert.equal(isPublicProductPath(pathname), true, pathname);
		}
	});

	it('does not expose unpublished catalog or administrator routes', () => {
		for (const pathname of [
			'/apps',
			'/dashboard',
			'/gateway/models',
			'/admin',
		]) {
			assert.equal(isPublicProductPath(pathname), false, pathname);
		}
	});
});
