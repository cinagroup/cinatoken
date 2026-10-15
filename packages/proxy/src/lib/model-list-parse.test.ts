import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	parseModelsKindQuery,
	parseModelsOutputModalitiesQuery,
	parseModelsRouteGroupsQuery,
	normalizePublicModelVendor,
	DEFAULT_MODELS_ROUTE_GROUPS,
} from './model-list-parse';

describe('parseModelsKindQuery', () => {
	it('defaults to llm when missing or empty', () => {
		assert.equal(parseModelsKindQuery(undefined), 'llm');
		assert.equal(parseModelsKindQuery(''), 'llm');
		assert.equal(parseModelsKindQuery('  '), 'llm');
	});

	it('accepts llm, image, audio, all (case-insensitive)', () => {
		assert.equal(parseModelsKindQuery('llm'), 'llm');
		assert.equal(parseModelsKindQuery('IMAGE'), 'image');
		assert.equal(parseModelsKindQuery('Audio'), 'audio');
		assert.equal(parseModelsKindQuery('All'), 'all');
		assert.equal(parseModelsKindQuery('Embeddings'), 'embedding');
	});

	it('falls back to llm for unknown values', () => {
		assert.equal(parseModelsKindQuery('chat'), 'llm');
		assert.equal(parseModelsKindQuery('unknown'), 'llm');
	});
});

describe('parseModelsOutputModalitiesQuery', () => {
	it('normalizes CSV and treats all as unfiltered', () => {
		assert.deepEqual(parseModelsOutputModalitiesQuery(' Text,Embeddings,text '), ['text', 'embeddings']);
		assert.equal(parseModelsOutputModalitiesQuery('all'), null);
		assert.equal(parseModelsOutputModalitiesQuery(undefined), null);
	});
});

describe('parseModelsRouteGroupsQuery', () => {
	it('defaults to default,free when missing', () => {
		assert.deepEqual(parseModelsRouteGroupsQuery(undefined), [...DEFAULT_MODELS_ROUTE_GROUPS]);
	});
});

describe('normalizePublicModelVendor', () => {
	it('falls back to other for empty or whitespace vendors', () => {
		assert.equal(normalizePublicModelVendor(undefined), 'other');
		assert.equal(normalizePublicModelVendor(null), 'other');
		assert.equal(normalizePublicModelVendor(''), 'other');
		assert.equal(normalizePublicModelVendor('   '), 'other');
	});

	it('keeps non-empty vendor values', () => {
		assert.equal(normalizePublicModelVendor('openai'), 'openai');
		assert.equal(normalizePublicModelVendor(' zhipu '), ' zhipu ');
	});
});
