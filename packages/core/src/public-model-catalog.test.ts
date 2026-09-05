import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	PUBLIC_CATALOG_TOP_PROVIDER_METADATA_KEY,
	parsePublicCatalogTopProviderSelection,
} from './public-model-catalog';

describe('public model catalog top-provider metadata', () => {
	it('distinguishes absence from one exact valid selector', () => {
		assert.deepEqual(parsePublicCatalogTopProviderSelection(null), { status: 'absent' });
		assert.deepEqual(parsePublicCatalogTopProviderSelection({ unrelated: true }), {
			status: 'absent',
		});
		assert.deepEqual(parsePublicCatalogTopProviderSelection({
			[PUBLIC_CATALOG_TOP_PROVIDER_METADATA_KEY]: {
				endpoint_tag: 'deepseek/standard',
				is_moderated: false,
			},
		}), {
			status: 'valid',
			selector: {
				endpointTag: 'deepseek/standard',
				isModerated: false,
			},
		});
	});

	it('rejects ambiguous shapes, unsafe tags, and inferred moderation', () => {
		for (const value of [
			null,
			[],
			{},
			{ endpoint_tag: '', is_moderated: false },
			{ endpoint_tag: 'deepseek?', is_moderated: false },
			{ endpoint_tag: 'deepseek', is_moderated: 'false' },
			{ endpoint_tag: 'deepseek', is_moderated: false, extra: true },
		]) {
			assert.deepEqual(parsePublicCatalogTopProviderSelection({
				[PUBLIC_CATALOG_TOP_PROVIDER_METADATA_KEY]: value,
			}), { status: 'invalid' });
		}
	});
});
