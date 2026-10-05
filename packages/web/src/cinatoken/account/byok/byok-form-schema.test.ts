import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ByokKey } from '../../byok-contracts'
import {
	byokCreateInput,
	byokFormSchema,
	byokKeyForm,
	byokPatchInput,
	completeByokGroup,
	EMPTY_BYOK_FORM,
	moveByokKey,
	orderedByokKeys,
} from './byok-form-schema'

const id = '38d0b6d8-b4bc-4d14-b22c-000000000001'
function row(overrides: Partial<ByokKey> = {}): ByokKey {
	return {
		id,
		workspace_id: 'workspace-a',
		provider: 'openai',
		name: null,
		label: '...1234',
		disabled: false,
		is_fallback: false,
		always_use_for_provider: false,
		always_use_for_matching_models: false,
		sort_order: 0,
		allowed_models: null,
		allowed_user_ids: null,
		allowed_api_key_hashes: null,
		created_at: '2026-09-27 00:00:00',
		...overrides,
	}
}
const values = {
	...EMPTY_BYOK_FORM,
	provider: 'openai',
	key: '  provider-secret  ',
}

test('creation preserves the exact credential bytes and binds the selected workspace', () => {
	const input = byokCreateInput(values, 'workspace-a')
	assert.equal(input.key, '  provider-secret  ')
	assert.equal(input.workspace_id, 'workspace-a')
	assert.equal(input.allowed_models, null)
	assert.throws(() => byokCreateInput({ ...values, key: '  ' }, 'workspace-a'))
})

test('editing a masked credential never reconstructs a secret or overwrites it with blank text', () => {
	const form = byokKeyForm(row())
	assert.equal(form.key, '')
	assert.equal('key' in byokPatchInput(form), false)
	assert.equal('key' in byokPatchInput({ ...form, key: '   ' }), false)
	assert.equal(
		byokPatchInput({ ...form, key: 'new-secret\n' }).key,
		'new-secret\n'
	)
})

test('unrestricted, deny-all and explicit restrictions survive editing without opening access', () => {
	for (const models of [null, [], ['provider/model']] as const) {
		const form = byokKeyForm(
			row({
				allowed_models: models === null ? null : [...models],
				allowed_user_ids: [],
			})
		)
		const input = byokPatchInput(form)
		assert.deepEqual(input.allowed_models, models)
		assert.deepEqual(input.allowed_user_ids, [])
	}
	assert.deepEqual(
		byokPatchInput({ ...values, modelsMode: 'list', allowedModels: 'a, a\nb' })
			.allowed_models,
		['a', 'b']
	)
})

test('restrictions validate only active modes while SHA-256 restrictions reject raw keys and prefixes', () => {
	assert.equal(
		byokFormSchema.safeParse({
			...values,
			allowedModels: '\u0000',
			modelsMode: 'any',
		}).success,
		true
	)
	for (const value of [
		'',
		'sk-secret',
		'sha256:' + 'a'.repeat(64),
		'A'.repeat(64),
		'a'.repeat(63),
	]) {
		assert.equal(
			byokFormSchema.safeParse({
				...values,
				keysMode: 'list',
				allowedApiKeyHashes: value,
			}).success,
			false,
			value
		)
	}
	assert.equal(
		byokFormSchema.safeParse({
			...values,
			keysMode: 'list',
			allowedApiKeyHashes: 'a'.repeat(64),
		}).success,
		true
	)
})

test('field limits count code points, credential limits count UTF-8 bytes, list limits include duplicates', () => {
	assert.equal(
		byokFormSchema.safeParse({ ...values, name: '😀'.repeat(255) }).success,
		true
	)
	assert.equal(
		byokFormSchema.safeParse({ ...values, name: '😀'.repeat(256) }).success,
		false
	)
	assert.equal(
		byokFormSchema.safeParse({ ...values, key: '😀'.repeat(16_384) }).success,
		true
	)
	assert.equal(
		byokFormSchema.safeParse({ ...values, key: '😀'.repeat(16_385) }).success,
		false
	)
	assert.equal(
		byokFormSchema.safeParse({
			...values,
			modelsMode: 'list',
			allowedModels: 'model'.repeat(1).concat('\n').repeat(101),
		}).success,
		false
	)
	assert.equal(
		byokFormSchema.safeParse({
			...values,
			modelsMode: 'list',
			allowedModels: 'a'.repeat(241),
		}).success,
		false
	)
	assert.equal(
		byokFormSchema.safeParse({
			...values,
			usersMode: 'list',
			allowedUserIds: 'a'.repeat(513),
		}).success,
		false
	)
})

test('fallback policies cannot block shared capacity and always-use modes remain mutually exclusive', () => {
	for (const policy of ['provider', 'matching_models'] as const) {
		assert.equal(
			byokFormSchema.safeParse({
				...values,
				isFallback: true,
				sharedCapacityPolicy: policy,
			}).success,
			false
		)
		const input = byokPatchInput({ ...values, sharedCapacityPolicy: policy })
		assert.notEqual(
			input.always_use_for_provider,
			input.always_use_for_matching_models
		)
	}
	const input = byokPatchInput({
		...values,
		isFallback: true,
		sharedCapacityPolicy: 'allow',
	})
	assert.equal(input.always_use_for_provider, false)
	assert.equal(input.always_use_for_matching_models, false)
})

test('complete reorder groups reject pagination truncation, mixed scope, duplicate IDs and zero rows', () => {
	const first = row()
	assert.throws(() => completeByokGroup([first], 2, 'workspace-a', 'openai'))
	assert.throws(() => completeByokGroup([first], 1, 'workspace-b', 'openai'))
	assert.throws(() => completeByokGroup([first], 1, 'workspace-a', 'anthropic'))
	assert.throws(() =>
		completeByokGroup([first, first], 2, 'workspace-a', 'openai')
	)
	assert.throws(() => completeByokGroup([], 0, 'workspace-a', 'openai'))
})

test('full provider ordering includes disabled credentials and preserves the user-moved order', () => {
	const first = row({ sort_order: 0 })
	const second = row({
		id: id.replace(/1$/, '2'),
		sort_order: 1,
		disabled: true,
	})
	const fallback = row({
		id: id.replace(/1$/, '3'),
		sort_order: 2,
		is_fallback: true,
	})
	const rows = orderedByokKeys([fallback, second, first])
	const moved = moveByokKey(rows, first.id, 1)
	assert.deepEqual(
		completeByokGroup(moved, 3, 'workspace-a', 'openai').map((item) => item.id),
		[second.id, first.id, fallback.id]
	)
	assert.deepEqual(moveByokKey(moved, first.id, 1), moved)
	assert.deepEqual(moveByokKey(moved, fallback.id, -1), moved)
	assert.deepEqual(
		rows.map((item) => item.id),
		[first.id, second.id, fallback.id]
	)
})
