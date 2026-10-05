import assert from 'node:assert/strict'
import test from 'node:test'
import { validateRequestPresetConfig } from '../../../../../core/src/request-presets.ts'
import {
	PRESET_CONFIG_FIELDS,
	presetConfigError,
} from '../../preset-contracts.ts'

test('browser config validator matches the actual Core contract across all advanced fields and limits', () => {
	const samples = [
		{},
		...PRESET_CONFIG_FIELDS.map((field) => ({
			[field]: field === 'provider' ? {} : 'advanced value',
		})),
		{ model: '@preset/another' },
		{ stream: true },
		{ input: [] },
		{ unknown: true },
		{ provider: null },
		{
			provider: {
				sort: { by: 'throughput', partition: 'none' },
				preferred_min_throughput: { p50: 10 },
				max_price: { image: 0.1 },
				quantizations: ['fp8'],
			},
		},
		{ provider: { only: ['a', 'a'] } },
		{ provider: { only: [] } },
		{ provider: { only: [''] } },
		{ provider: { only: Array(33).fill('a') } },
		{ provider: { zdr: 'true' } },
		{ provider: { sort: { by: 'price', secret: true } } },
		{ provider: { quantizations: [] } },
		{ provider: { max_price: { prompt: -1 } } },
		{ tools: [{ nested: { Authorization: 'private' } }] },
		{ temperature: 'legacy legal type' },
		{ temperature: -99 },
		{ stop: Array(513).fill('x') },
		{ tools: [{ name: 'x', args: Array(512).fill('x') }] },
		{ model: '😀'.repeat(17000) },
		{
			logit_bias: Object.fromEntries(
				Array.from({ length: 4096 }, (_, id) => [id, 1])
			),
		},
		{ temperature: Infinity },
		null,
		[],
		'text',
	]
	let nested = { text: 'end' }
	for (let depth = 0; depth < 11; depth++) nested = { text: nested }
	samples.push({ tools: nested })
	for (const sample of samples)
		assert.equal(
			presetConfigError(sample) === null,
			validateRequestPresetConfig(sample).ok,
			JSON.stringify(sample)?.slice(0, 120)
		)
})
