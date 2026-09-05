import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	parseMetadataForSave,
	publicCatalogTopProviderEditorState,
	updatePublicCatalogTopProviderMetadata,
} from '../../../app/gateway/models/model-utils';

describe('public catalog top-provider model metadata editor', () => {
	it('round-trips a strict selector while preserving unrelated metadata', () => {
		const updated = updatePublicCatalogTopProviderMetadata(
			'{"architecture":"GPT","private_note":"keep"}',
			{ endpointTag: 'deepseek/standard', isModerated: true },
		);
		assert.equal(updated.ok, true);
		if (!updated.ok) return;
		assert.deepEqual(publicCatalogTopProviderEditorState(updated.value), {
			status: 'ready',
			enabled: true,
			selectorValid: true,
			endpointTag: 'deepseek/standard',
			isModerated: true,
		});
		assert.deepEqual(JSON.parse(updated.value), {
			architecture: 'GPT',
			private_note: 'keep',
			public_catalog_top_provider: {
				endpoint_tag: 'deepseek/standard',
				is_moderated: true,
			},
		});
		assert.equal(parseMetadataForSave(updated.value).ok, true);
	});

	it('preserves partial input but blocks malformed selectors at save time', () => {
		const partial = '{"public_catalog_top_provider":{"endpoint_tag":"deepseek?","is_moderated":false}}';
		assert.deepEqual(publicCatalogTopProviderEditorState(partial), {
			status: 'ready',
			enabled: true,
			selectorValid: false,
			endpointTag: 'deepseek?',
			isModerated: false,
		});
		assert.equal(parseMetadataForSave(partial).ok, false);
		assert.equal(parseMetadataForSave(
			'{"public_catalog_top_provider":{"endpoint_tag":"deepseek","is_moderated":false,"extra":true}}'
		).ok, false);
	});

	it('never overwrites invalid raw metadata and can remove only the selector', () => {
		assert.deepEqual(publicCatalogTopProviderEditorState('{'), {
			status: 'metadata-invalid',
		});
		assert.deepEqual(updatePublicCatalogTopProviderMetadata('{', null), { ok: false });

		const removed = updatePublicCatalogTopProviderMetadata(
			'{"keep":1,"public_catalog_top_provider":{"endpoint_tag":"deepseek","is_moderated":false}}',
			null,
		);
		assert.equal(removed.ok, true);
		if (!removed.ok) return;
		assert.deepEqual(JSON.parse(removed.value), { keep: 1 });
	});
});
