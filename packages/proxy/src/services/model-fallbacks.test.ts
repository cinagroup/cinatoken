import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	buildModelFallbackTrace,
	parseAnthropicModelFallbacks,
	parseOpenAiModelFallbacks,
} from './model-fallbacks';

describe('OpenAI model fallback controls', () => {
	it('accepts models without model and strips the gateway control upstream', () => {
		const body = { models: ['model-a', 'model-b'], messages: [] };
		const result = parseOpenAiModelFallbacks(body);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.value.modelIds, ['model-a', 'model-b']);
		assert.deepEqual(result.value.upstreamBody, { model: 'model-a', messages: [] });
		assert.equal('models' in body, true);
	});

	it('places model before models and removes duplicates', () => {
		const result = parseOpenAiModelFallbacks({
			model: 'model-a',
			models: ['model-a', 'model-b'],
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.value.modelIds, ['model-a', 'model-b']);
	});

	it('rejects missing, malformed, and excessive candidates', () => {
		assert.equal(parseOpenAiModelFallbacks({}).ok, false);
		assert.equal(parseOpenAiModelFallbacks({ models: [] }).ok, false);
		assert.equal(
			parseOpenAiModelFallbacks({ models: Array.from({ length: 9 }, (_, index) => `m-${index}`) }).ok,
			false,
		);
	});
});

describe('Anthropic model fallback controls', () => {
	it('accepts strict fallback entries and strips them upstream', () => {
		const result = parseAnthropicModelFallbacks({
			model: 'model-a',
			fallbacks: [{ model: 'model-b' }, { model: 'model-c' }],
			messages: [],
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.value.modelIds, ['model-a', 'model-b', 'model-c']);
		assert.deepEqual(result.value.upstreamBody, { model: 'model-a', messages: [] });
	});

	it('rejects overrides, more than three fallbacks, and mixed control forms', () => {
		assert.equal(
			parseAnthropicModelFallbacks({ model: 'a', fallbacks: [{ model: 'b', max_tokens: 1 }] }).ok,
			false,
		);
		assert.equal(
			parseAnthropicModelFallbacks({
				model: 'a',
				fallbacks: ['b', 'c', 'd', 'e'].map((model) => ({ model })),
			}).ok,
			false,
		);
		assert.equal(
			parseAnthropicModelFallbacks({ model: 'a', models: ['b'], fallbacks: [{ model: 'c' }] }).ok,
			false,
		);
	});
});

it('builds a sanitized trace only for real fallback requests', () => {
	assert.equal(buildModelFallbackTrace(['a'], []), null);
	assert.deepEqual(
		buildModelFallbackTrace(
			['a', 'b'],
			[
				{ model: 'a', base_model: 'a', route_group: 'default', status: 429, outcome: 'error', error_code: 'upstream.rate_limited' },
				{ model: 'b', base_model: 'b', route_group: 'default', status: 200, outcome: 'success' },
			],
		),
		{
			original_model: 'a',
			requested_models: ['a', 'b'],
			final_model: 'b',
			fallback_count: 1,
			attempts: [
				{ model: 'a', base_model: 'a', route_group: 'default', status: 429, outcome: 'error', error_code: 'upstream.rate_limited' },
				{ model: 'b', base_model: 'b', route_group: 'default', status: 200, outcome: 'success' },
			],
		},
	);
});
