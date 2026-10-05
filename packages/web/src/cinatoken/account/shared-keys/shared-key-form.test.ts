import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError } from '../../api'
import { SharedKeyHistoryConflict } from '../../shared-key-api'
import type { SharedKey, SharedKeyCatalog } from '../../shared-key-contracts'
import { sharedKeyMessages } from './messages'
import {
	canManageSharedKeys,
	sharedKeyCreateInput,
	sharedKeyDefaults,
	sharedKeyFormSchema,
	sharedKeyPage,
	sharedKeyPatchInput,
} from './shared-key-form'
import {
	sharedKeyAccessFailure,
	sharedKeyErrorKey,
	sharedKeyQueryKey,
} from './use-shared-keys'

const catalog: SharedKeyCatalog = {
	channels: [{ channelType: 'openai', label: 'OpenAI', modelsUrl: null }],
	limits: { maxInputPrice: 5, maxOutputPrice: 8, commissionRate: 0.1 },
	billingCurrency: 'CNY',
}
const values = {
	...sharedKeyDefaults(catalog),
	apiKey: '  upstream-key  ',
	inputPrice: '1.000001',
	outputPrice: '3',
	cacheReadPrice: '',
	cacheWritePrice: '0',
	weight: '100',
}
test('shared seller management requires its exact capability, independent of account visibility or other key roles', () => {
	assert.equal(canManageSharedKeys(['account.read']), false)
	assert.equal(
		canManageSharedKeys([
			'account.read',
			'gateway_keys.manage',
			'management_keys.manage',
			'admin.console',
		]),
		false
	)
	assert.equal(canManageSharedKeys(['shared_keys.manage']), true)
	assert.equal(canManageSharedKeys(['shared_keys.manage.extra']), false)
})
test('listing forms enforce server channel and six-decimal price bounds without inventing cache caps', () => {
	const schema = sharedKeyFormSchema(catalog, false)
	assert.equal(schema.safeParse(values).success, true)
	for (const patch of [
		{ inputPrice: '0' },
		{ inputPrice: '5.000001' },
		{ outputPrice: '8.000001' },
		{ inputPrice: '0.0000001' },
		{ inputPrice: 'Infinity' },
		{ weight: '101' },
		{ weight: '1.2' },
		{ apiKey: '       ' },
		{ channelType: 'anthropic' },
		{ label: 'a'.repeat(129) },
	])
		assert.equal(schema.safeParse({ ...values, ...patch }).success, false)
	assert.equal(
		schema.safeParse({ ...values, cacheReadPrice: '900' }).success,
		true
	)
	assert.equal(
		sharedKeyFormSchema(catalog, true).safeParse({
			...values,
			channelType: 'anthropic',
			apiKey: '',
		}).success,
		true
	)
})
test('blank cache pricing remains null, explicit zero stays zero and editing never includes credential or channel', () => {
	const created = sharedKeyCreateInput(values)
	assert.equal(created.apiKey, 'upstream-key')
	assert.equal(created.cacheReadPrice, null)
	assert.equal(created.cacheWritePrice, 0)
	const edited = sharedKeyPatchInput(values)
	assert.equal('apiKey' in edited, false)
	assert.equal('channelType' in edited, false)
	assert.equal('sellerPriority' in edited, false)
})
test('client pagination filters the global seller collection and clamps after deletion without losing matching rows', () => {
	const rows = Array.from(
		{ length: 45 },
		(_, index) =>
			({
				id: String(index),
				channelType: index === 44 ? 'anthropic' : 'openai',
				label: `Listing ${index}`,
				apiKeyMasked: 'sk-…tail',
				keyFingerprint: '…tail',
				status: index === 44 ? 'paused' : 'active',
			}) as SharedKey
	)
	assert.equal(
		sharedKeyPage(rows, { search: '', status: '', channel: '' }, 0).rows.length,
		20
	)
	const last = sharedKeyPage(rows, { search: '', status: '', channel: '' }, 99)
	assert.equal(last.page, 2)
	assert.equal(last.rows.length, 5)
	const filtered = sharedKeyPage(
		rows,
		{ search: 'TAIL', status: 'paused', channel: 'anthropic' },
		1
	)
	assert.equal(filtered.page, 0)
	assert.equal(filtered.total, 1)
	assert.equal(filtered.rows[0].id, '44')
})
test('resource history conflict, operation 403 and genuine scope conflicts have different recovery semantics', () => {
	assert.equal(
		sharedKeyErrorKey(new SharedKeyHistoryConflict(), 'delete'),
		'cinatoken.account.sharedKeys.historyLocked'
	)
	assert.equal(
		sharedKeyErrorKey(
			new CinaTokenApiError('disabled', 403, 'http'),
			'validate'
		),
		'cinatoken.account.sharedKeys.adminDisabled'
	)
	assert.equal(
		sharedKeyAccessFailure(new CinaTokenApiError('forbidden', 403, 'http')),
		true
	)
	assert.equal(
		sharedKeyAccessFailure(
			new CinaTokenApiError('invalid owner', 200, 'invalid-response')
		),
		true
	)
	assert.equal(
		sharedKeyAccessFailure(new CinaTokenApiError('unavailable', 503, 'http')),
		false
	)
	assert.equal(sharedKeyAccessFailure(new SharedKeyHistoryConflict()), false)
	const scope = { userId: 'alice', workspaceId: 'team', scopeVersion: 1 }
	assert.notDeepEqual(
		sharedKeyQueryKey(scope),
		sharedKeyQueryKey({ ...scope, scopeVersion: 2 })
	)
	assert.notDeepEqual(
		sharedKeyQueryKey(scope),
		sharedKeyQueryKey({ ...scope, userId: 'bob' })
	)
})
test('shared key translations have matching keys and interpolation multisets in every locale', () => {
	const baseline = sharedKeyMessages.en
	for (const locale of Object.values(sharedKeyMessages)) {
		assert.deepEqual(Object.keys(locale).sort(), Object.keys(baseline).sort())
		for (const key of Object.keys(baseline) as (keyof typeof baseline)[]) {
			assert.ok(locale[key].trim())
			assert.deepEqual(
				(locale[key].match(/\{\{\w+\}\}/gu) ?? []).sort(),
				(baseline[key].match(/\{\{\w+\}\}/gu) ?? []).sort(),
				key
			)
		}
	}
})
