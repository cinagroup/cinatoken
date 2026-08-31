import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPostgresModelRoutePatch } from './model-route-patch';

test('Postgres model-route patches retain only allowlisted columns', () => {
	assert.deepEqual(
		buildPostgresModelRoutePatch({
			provider_model_name: 'upstream-model',
			routing_metadata: '{"region":"sg"}',
			status: undefined,
			created_at: 'must-not-be-writable',
			'status = \'disabled\' WHERE 1=1 --': 'injected',
		}),
		{
			providerModelName: 'upstream-model',
			routingMetadata: '{"region":"sg"}',
		}
	);
});
