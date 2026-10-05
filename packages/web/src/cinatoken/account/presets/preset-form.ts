import { z } from 'zod'
import {
	normalizePresetSlug,
	presetConfigError,
	PRESET_PROMPT_MAX_BYTES,
	savePresetVersionInputSchema,
	type PresetVersion,
	type RequestPreset,
	type SavePresetVersionInput,
} from '../../preset-contracts'

const prefix = 'cinatoken.presets.validation.'
export const presetFormSchema = z
	.object({
		slug: z
			.string()
			.refine(
				(value) =>
					/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u.test(
						normalizePresetSlug(value)
					),
				prefix + 'slug'
			),
		name: z
			.string()
			.trim()
			.max(128, prefix + 'name'),
		description: z
			.string()
			.trim()
			.max(1024, prefix + 'description'),
		visibility: z.enum(['private', 'public']),
		systemPrompt: z
			.string()
			.refine(
				(value) =>
					new TextEncoder().encode(value).byteLength <= PRESET_PROMPT_MAX_BYTES,
				prefix + 'promptBytes'
			),
		guidedValid: z.boolean(),
		configText: z.string().superRefine((value, context) => {
			let config: unknown
			try {
				config = JSON.parse(value)
			} catch {
				context.addIssue({ code: 'custom', message: prefix + 'json' })
				return
			}
			const error = presetConfigError(config)
			if (error) context.addIssue({ code: 'custom', message: prefix + error })
		}),
	})
	.superRefine((value, context) => {
		if (!value.guidedValid)
			context.addIssue({
				code: 'custom',
				path: ['configText'],
				message: prefix + 'number',
			})
	})
export type PresetForm = z.infer<typeof presetFormSchema>
export const presetMetadataFormSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, prefix + 'name')
		.max(128, prefix + 'name'),
	description: z
		.string()
		.trim()
		.max(1024, prefix + 'description'),
	visibility: z.enum(['private', 'public']),
})
export type PresetMetadataForm = z.infer<typeof presetMetadataFormSchema>
export function presetDefaults(
	row?: RequestPreset,
	version?: PresetVersion
): PresetForm {
	const source = version ?? row
	let configText = JSON.stringify({ model: '', temperature: 0.2 }, null, 2)
	if (source)
		configText =
			source.config === null ? '' : JSON.stringify(source.config, null, 2)
	return {
		slug: row?.slug ?? '',
		name: row?.name ?? '',
		description: row?.description ?? '',
		visibility: row?.visibility ?? 'private',
		systemPrompt: source?.systemPrompt ?? '',
		guidedValid: true,
		configText,
	}
}
export function presetFormInput(values: PresetForm): SavePresetVersionInput {
	const checked = presetFormSchema.parse(values)
	return savePresetVersionInputSchema.parse({
		slug: checked.slug,
		name: checked.name,
		description: checked.description || null,
		visibility: checked.visibility,
		systemPrompt: checked.systemPrompt === '' ? null : checked.systemPrompt,
		config: JSON.parse(checked.configText) as Record<string, unknown>,
	})
}
export function presetPage(
	rows: RequestPreset[],
	filter: { search: string; status: string; visibility: string },
	page: number
) {
	const search = filter.search.trim().toLowerCase()
	const filtered = rows.filter(
		(row) =>
			(!filter.status || row.status === filter.status) &&
			(!filter.visibility || row.visibility === filter.visibility) &&
			(!search ||
				[row.slug, row.name, row.description ?? ''].some((value) =>
					value.toLowerCase().includes(search)
				))
	)
	const pages = Math.max(1, Math.ceil(filtered.length / 20))
	const current = Math.max(0, Math.min(page, pages - 1))
	return {
		rows: filtered.slice(current * 20, (current + 1) * 20),
		total: filtered.length,
		page: current,
		pages,
	}
}
