import assert from 'node:assert/strict';
import test from 'node:test';
import { createPortalMeResponse } from './user-app';
import { getAccountCapabilities } from './unified-session';

test('portal me response uses the shared success/data contract', () => {
	assert.deepEqual(
		createPortalMeResponse({
			userId: 'user-123',
			subject: 'cinaauth-subject-123',
			email: 'user@example.com',
			isAdmin: false,
			capabilities: getAccountCapabilities(false),
		}),
		{
			success: true,
			data: {
				userId: 'user-123',
				subject: 'cinaauth-subject-123',
				email: 'user@example.com',
				isAdmin: false,
				capabilities: getAccountCapabilities(false),
				organizations: [],
			},
		},
	);
});
