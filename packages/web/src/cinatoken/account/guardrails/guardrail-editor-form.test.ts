/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	guardrailMetadataDraft,
	guardrailNewInput,
	guardrailNewVersionInput,
} from './guardrail-editor-form'

const row = {
	name: 'Policy',
	description: 'Original notes',
	isAccountDefault: false,
	isWorkspaceDefault: false,
}

test('metadata edits carry only changed fields and do not require a version configuration', () => {
	assert.deepEqual(
		guardrailMetadataDraft(row, { name: 'Policy', description: ' New notes ' }),
		{ kind: 'ready', input: { description: 'New notes' } }
	)
	assert.deepEqual(
		guardrailMetadataDraft(row, {
			name: ' New name ',
			description: row.description,
		}),
		{ kind: 'ready', input: { name: 'New name' } }
	)
})

test('unchanged or normalization-only metadata drafts send no patch', () => {
	for (const values of [
		{ name: row.name, description: row.description },
		{ name: ' Policy ', description: 'Original notes ' },
		{},
	])
		assert.deepEqual(guardrailMetadataDraft(row, values), { kind: 'unchanged' })
})

test('both default types ignore immutable name values while retaining explicit description edits', () => {
	for (const kind of ['isAccountDefault', 'isWorkspaceDefault'] as const) {
		const original = { ...row, [kind]: true }
		assert.deepEqual(
			guardrailMetadataDraft(original, { name: 'Tampered', description: '' }),
			{ kind: 'ready', input: { description: null } }
		)
		assert.deepEqual(guardrailMetadataDraft(original, { name: '' }), {
			kind: 'unchanged',
		})
	}
})

test('metadata preserves explicit clearing and rejects invalid edited fields locally', () => {
	assert.deepEqual(guardrailMetadataDraft(row, { description: '  ' }), {
		kind: 'ready',
		input: { description: null },
	})
	assert.deepEqual(
		guardrailMetadataDraft({ ...row, description: null }, { description: '' }),
		{ kind: 'unchanged' }
	)
	for (const values of [
		{ name: '' },
		{ name: ' ' },
		{ name: 'x'.repeat(129) },
		{ description: 'x'.repeat(1025) },
	])
		assert.deepEqual(guardrailMetadataDraft(row, values), { kind: 'invalid' })
})

test('new versions preserve unchanged metadata through the existing config-only POST contract', () => {
	for (const original of [
		row,
		{ ...row, isAccountDefault: true },
		{ ...row, isWorkspaceDefault: true },
	])
		assert.deepEqual(
			guardrailNewVersionInput(
				original,
				{ name: row.name, description: row.description },
				{ require_zdr: true }
			),
			{ config: { require_zdr: true } }
		)
})

test('new versions include explicit metadata changes, nullable clearing and immutable default names', () => {
	assert.deepEqual(
		guardrailNewVersionInput(row, { name: ' Renamed ', description: '' }, {}),
		{ name: 'Renamed', description: null, config: {} }
	)
	assert.deepEqual(
		guardrailNewVersionInput(
			{ ...row, isWorkspaceDefault: true },
			{ name: 'Tampered', description: ' Updated ' },
			{}
		),
		{ description: 'Updated', config: {} }
	)
})

test('creation still requires a name and valid configuration while both version branches reject malformed inputs', () => {
	assert.deepEqual(
		guardrailNewInput({ name: ' New rule ', description: ' ' }, {}),
		{ name: 'New rule', description: null, config: {} }
	)
	assert.throws(() => guardrailNewInput({ name: '' }, {}))
	assert.throws(() =>
		guardrailNewInput({ name: 'New' }, { unknown: true } as never)
	)
	assert.throws(() => guardrailNewVersionInput(row, { name: '' }, {}))
	assert.throws(() =>
		guardrailNewVersionInput(row, {}, { unknown: true } as never)
	)
})
