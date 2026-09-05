import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from './model-router';
import { buildRouteRequestBody } from './route-default-params';

describe('route default gateway controls', () => {
	it('removes session_id from both route defaults and the user body', () => {
		const route = {
			customParams: { session_id: 'route-secret', temperature: 0.5 },
			gatewaySessionIdControlled: true,
		} as RouteResult;
		assert.deepEqual(
			buildRouteRequestBody(route, { session_id: 'user-session', top_p: 0.9 }),
			{ temperature: 0.5, top_p: 0.9 },
		);
	});
});
