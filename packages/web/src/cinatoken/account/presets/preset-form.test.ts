import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../api'
import type { RequestPreset } from '../../preset-contracts'
import { presetsMessages } from './messages'
import {
	changePresetField,
	parsePresetNumber,
	presetConfigurationBytes,
	readPresetConfig,
} from './preset-config-editor'
import { presetAccessFailure, presetErrorKey } from './preset-errors'
import {
	presetDefaults,
	presetFormInput,
	presetFormSchema,
	presetMetadataFormSchema,
	presetPage,
} from './preset-form'

const advanced = {
	model: 'model-a',
	tools: [{ function: { name: 'lookup' } }],
	reasoning: { effort: 'high' },
	provider: {
		max_price: { prompt: 0.3 },
		sort: { by: 'latency', partition: 'none' },
		enforce_distillable_text: true,
	},
	modalities: ['text', 'image'],
	route_group: 'fast',
	temperature: 'legacy-but-legal',
}
const row: RequestPreset = {
	id: 'p1',
	workspaceId: 'w1',
	ownerUserId: 'u1',
	slug: 'one',
	name: 'One',
	description: 'description',
	status: 'active',
	visibility: 'private',
	latestVersion: 3,
	designatedVersion: 1,
	config: advanced,
	systemPrompt: ' \n Exact prompt \n ',
	createdAt: '',
	updatedAt: '',
	versionCreatedAt: '',
}
test('editor defaults preserve the active configuration and exact prompt; corrupt configuration is not replaced with an empty object', () => {
	const defaults = presetDefaults(row)
	assert.deepEqual(presetFormInput(defaults).config, advanced)
	assert.equal(presetFormInput(defaults).systemPrompt, row.systemPrompt)
	assert.equal(presetDefaults({ ...row, config: null }).configText, '')
	assert.equal(
		presetFormSchema.safeParse(presetDefaults({ ...row, config: null }))
			.success,
		false
	)
	assert.equal(
		presetDefaults(row, {
			id: 'v2',
			version: 2,
			config: { model: 'old' },
			systemPrompt: 'history',
			createdByUserId: null,
			createdAt: '',
		}).systemPrompt,
		'history'
	)
})
test('convenient fields preserve advanced and provider configuration without mutating the source', () => {
	const changed = readPresetConfig(
		changePresetField(advanced, 'temperature', 0.6)
	)!
	assert.deepEqual(changed, { ...advanced, temperature: 0.6 })
	assert.equal(advanced.temperature, 'legacy-but-legal')
	const providers = readPresetConfig(
		changePresetField(changed, 'only', ['provider-a'], true)
	)!
	assert.deepEqual(providers.provider, {
		...advanced.provider,
		only: ['provider-a'],
	})
	const cleared = readPresetConfig(
		changePresetField(providers, 'only', undefined, true)
	)!
	assert.deepEqual(cleared.provider, advanced.provider)
	assert.equal(readPresetConfig('[]'), null)
	assert.equal(readPresetConfig('{bad'), null)
	assert.equal(
		presetConfigurationBytes('{\n  "model": "😀"\n}'),
		new TextEncoder().encode('{"model":"😀"}').byteLength
	)
})
test('numeric drafts reject incomplete and non-finite values without narrowing server-supported finite ranges', () => {
	for (const value of ['-', '+', '1e', 'Infinity', 'NaN', '0x10', '1e999'])
		assert.equal(parsePresetNumber(value).valid, false)
	for (const value of ['-.2', '1e-3', '0', '-99', '2.5', ''])
		assert.equal(parsePresetNumber(value).valid, true)
	assert.equal(
		presetFormSchema.safeParse({ ...presetDefaults(row), guidedValid: false })
			.success,
		false
	)
})
test('form validates UTF-8 prompt limits, metadata lengths and canonical slug while allowing complete advanced JSON', () => {
	const values = {
		...presetDefaults(row),
		slug: ' @preset/HELPFUL ',
		systemPrompt: '😀'.repeat(8192),
	}
	assert.equal(presetFormInput(values).slug, 'helpful')
	assert.equal(
		presetFormSchema.safeParse({
			...values,
			systemPrompt: values.systemPrompt + 'a',
		}).success,
		false
	)
	for (const patch of [
		{ name: 'x'.repeat(129) },
		{ description: 'x'.repeat(1025) },
		{ slug: 'bad/' },
		{ configText: '{"messages":[]}' },
		{ configText: '{"tools":[{"api_key":"credential"}]}' },
	])
		assert.equal(
			presetFormSchema.safeParse({ ...values, ...patch }).success,
			false
		)
	assert.equal(
		presetMetadataFormSchema.safeParse({
			name: '',
			description: '',
			visibility: 'private',
		}).success,
		false
	)
	assert.equal(
		presetFormInput({ ...presetDefaults(), slug: 'a', configText: '{}' })
			.systemPrompt,
		null
	)
})
test('client pagination clamps deleted pages and filters search/status/visibility together', () => {
	const rows = Array.from({ length: 45 }, (_, index) => ({
		...row,
		id: String(index),
		name: `Preset ${index}`,
		status: index % 2 ? ('archived' as const) : ('active' as const),
	}))
	assert.equal(
		presetPage(rows, { search: '', status: '', visibility: '' }, 1).rows.length,
		20
	)
	assert.equal(
		presetPage(rows.slice(0, 2), { search: '', status: '', visibility: '' }, 2)
			.page,
		0
	)
	assert.equal(
		presetPage(
			rows,
			{ search: 'Preset 4', status: 'active', visibility: 'private' },
			0
		).total,
		4
	)
})
test('access loss hides private editors while action 403/404/conflicts use distinct safe copy', () => {
	assert.equal(
		presetAccessFailure(new CinaTokenApiError('x', 403, 'http')),
		true
	)
	assert.equal(
		presetAccessFailure(new CinaTokenApiError('x', 0, 'invalid-response')),
		true
	)
	assert.equal(
		presetAccessFailure(new CinaTokenApiError('x', 500, 'http')),
		false
	)
	assert.equal(
		presetErrorKey(new CinaTokenApiError('x', 409, 'http')),
		'cinatoken.presets.conflict'
	)
	assert.equal(
		presetErrorKey(new CinaTokenApiError('x', 403, 'http')),
		'cinatoken.presets.forbidden'
	)
})
function leaves(value: object, prefix = ''): Map<string, string> {
	const output = new Map<string, string>()
	for (const [key, item] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key
		if (typeof item === 'string') output.set(path, item)
		else
			for (const [key, text] of leaves(item as object, path))
				output.set(key, text)
	}
	return output
}
test('all four locales expose every operation and matching interpolation variables with explicit save activation', () => {
	const baseline = leaves(presetsMessages.en)
	assert.match(presetsMessages.en.activationHint, /immediately/)
	assert.match(presetsMessages.en.save, /activate/)
	for (const locale of ['zh', 'ja', 'ko'] as const) {
		const translated = leaves(presetsMessages[locale])
		assert.deepEqual([...translated.keys()].sort(), [...baseline.keys()].sort())
		for (const [key, text] of translated) {
			assert.ok(text.trim())
			assert.deepEqual(
				(text.match(/\{\{.*?\}\}/gu) ?? []).sort(),
				(baseline.get(key)?.match(/\{\{.*?\}\}/gu) ?? []).sort(),
				`${locale}:${key}`
			)
		}
	}
})
