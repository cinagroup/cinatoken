import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	EMPTY_RERANK_MODEL_FORM,
	parseModelListKindFilterParam,
} from './types';

describe('models rerank kind', () => {
	it('accepts rerank in the persisted list filter', () => {
		assert.equal(parseModelListKindFilterParam('rerank'), 'rerank');
		assert.equal(parseModelListKindFilterParam(' RERANK '), 'rerank');
	});

	it('uses a text-to-rerank form without a generated-token limit', () => {
		assert.deepEqual(EMPTY_RERANK_MODEL_FORM.input_modalities, ['text']);
		assert.deepEqual(EMPTY_RERANK_MODEL_FORM.output_modalities, ['rerank']);
		assert.equal(EMPTY_RERANK_MODEL_FORM.max_tokens, '');
	});
});
