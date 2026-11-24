/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	guardrailCreateInputSchema,
	guardrailPatchInputSchema,
	guardrailVersionInputSchema,
	type Guardrail,
	type GuardrailConfig,
	type GuardrailInput,
	type GuardrailPatch,
	type GuardrailVersionInput,
} from '../../guardrail-contracts'

export type GuardrailEditorValues = { name?: string; description?: string }
type MetadataRow = Pick<
	Guardrail,
	'name' | 'description' | 'isAccountDefault' | 'isWorkspaceDefault'
>
type MetadataInput = Pick<GuardrailPatch, 'name' | 'description'>
export type GuardrailMetadataDraft =
	| { kind: 'unchanged' }
	| { kind: 'invalid' }
	| { kind: 'ready'; input: MetadataInput }

/** Compare against the editor's initial row, never a later background read. */
export function guardrailMetadataDraft(
	row: MetadataRow,
	values: GuardrailEditorValues
): GuardrailMetadataDraft {
	const input: MetadataInput = {}
	if (
		!row.isAccountDefault &&
		!row.isWorkspaceDefault &&
		values.name !== undefined &&
		values.name !== row.name
	)
		input.name = values.name
	if (
		values.description !== undefined &&
		values.description !== (row.description ?? '')
	)
		input.description = values.description.trim() || null
	if (!Object.keys(input).length) return { kind: 'unchanged' }
	const parsed = guardrailPatchInputSchema.safeParse(input)
	if (!parsed.success) return { kind: 'invalid' }
	if (parsed.data.name === row.name) delete parsed.data.name
	if (parsed.data.description === row.description)
		delete parsed.data.description
	if (!Object.keys(parsed.data).length) return { kind: 'unchanged' }
	return { kind: 'ready', input: parsed.data }
}

export function guardrailNewVersionInput(
	row: MetadataRow,
	values: GuardrailEditorValues,
	config: GuardrailConfig
): GuardrailVersionInput {
	const metadata = guardrailMetadataDraft(row, values)
	if (metadata.kind === 'invalid')
		throw new TypeError('Invalid Guardrail metadata')
	return guardrailVersionInputSchema.parse({
		...(metadata.kind === 'ready' ? metadata.input : {}),
		config,
	})
}

export function guardrailNewInput(
	values: GuardrailEditorValues,
	config: GuardrailConfig
): GuardrailInput {
	return guardrailCreateInputSchema.parse({
		name: values.name,
		description: values.description?.trim() || null,
		config,
	})
}
