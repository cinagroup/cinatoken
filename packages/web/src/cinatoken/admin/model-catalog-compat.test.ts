import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	modelCatalogResponseSchema,
	modelSyncReportSchema,
} from './model-contracts'
import { modelSyncFixture } from './models/model-sync-fixtures'

const kinds = ['llm', 'image', 'asr', 'tts', 'embedding', 'rerank', 'audio']
const expected = ['llm', 'image', 'audio', 'audio', 'llm', 'rerank', 'audio']
function catalogRow(kind: unknown, index = 0) {
	return {
		id: 'model-' + index,
		display_name: null,
		vendor: 'other',
		kind,
		context_window: null,
		max_tokens: null,
		description: null,
		i18n: null,
		tier_count: 0,
		pricing_label: null,
		pricing_preview: null,
	}
}

test('mixed Gateway catalog kinds stay importable through existing Web filters', () => {
	const response = {
		success: true,
		data: kinds.map(catalogRow),
		count: kinds.length,
		billing_currency: 'USD',
	}
	const catalog = modelCatalogResponseSchema.parse(response)
	assert.deepEqual(
		catalog.data.map((row) => row.kind),
		expected
	)
	assert.equal(catalog.data.filter((row) => row.kind === 'audio').length, 3)
	assert.equal(catalog.data.filter((row) => row.kind === 'rerank').length, 1)
	for (const kind of ['video', '', null, 3])
		assert.equal(
			modelCatalogResponseSchema.safeParse({
				...response,
				data: [catalogRow(kind)],
				count: 1,
			}).success,
			false
		)
	assert.equal(
		modelCatalogResponseSchema.safeParse({
			...response,
			data: [{ ...catalogRow('tts'), tier_count: -1 }],
			count: 1,
		}).success,
		false
	)
})

test('official sync projects the same detailed kinds without weakening report validation', () => {
	const base = modelSyncFixture.groups[0]!.models[0]!
	const response = {
		...modelSyncFixture,
		models_with_diff: kinds.length,
		groups: [
			{
				vendor: 'other',
				vendor_label: 'Other',
				models: kinds.map((kind, index) => ({
					...base,
					model_id: 'model-' + index,
					kind,
				})),
			},
		],
	}
	assert.deepEqual(
		modelSyncReportSchema
			.parse(response)
			.groups[0]!.models.map((row) => row.kind),
		expected
	)
	assert.equal(
		modelSyncReportSchema.safeParse({ ...response, models_with_diff: 1 })
			.success,
		false
	)
	assert.equal(
		modelSyncReportSchema.safeParse({
			...response,
			groups: [
				{ ...response.groups[0], models: [{ ...base, kind: 'unknown' }] },
			],
			models_with_diff: 1,
		}).success,
		false
	)
})
