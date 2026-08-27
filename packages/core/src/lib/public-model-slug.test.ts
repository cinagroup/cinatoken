import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toPublicModelSlug } from './public-model-slug';

describe('toPublicModelSlug', () => {
	it('keeps existing simple model ids readable', () => {
		assert.equal(toPublicModelSlug('gpt-5.4-mini'), 'gpt-5.4-mini');
		assert.equal(toPublicModelSlug('model:free'), 'model:free');
	});

	it('encodes path-significant and Unicode ids as one stable segment', () => {
		assert.equal(toPublicModelSlug('openai/gpt-5'), '~b3BlbmFpL2dwdC01');
		assert.equal(toPublicModelSlug('模型 alpha'), '~5qih5Z6LIGFscGhh');
		assert.doesNotMatch(toPublicModelSlug('openai/gpt-5'), /\//);
	});
});
