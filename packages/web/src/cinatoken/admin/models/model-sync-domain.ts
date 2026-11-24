/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type {
	ModelSyncFieldKey,
	ModelSyncItem,
	ModelSyncReport,
} from '../model-contracts'

export function modelSyncSelectionKey(
	modelId: string,
	field: ModelSyncFieldKey
): string {
	return JSON.stringify([modelId, field])
}

/** Only fields present in this exact report may be applied. No defaults or hidden keys. */
export function selectedModelSyncItems(
	report: ModelSyncReport,
	selection: readonly string[]
): ModelSyncItem[] {
	const selected = new Set(selection)
	const items: ModelSyncItem[] = []
	for (const group of report.groups) {
		for (const model of group.models) {
			const fields = model.fields
				.filter((field) =>
					selected.delete(modelSyncSelectionKey(model.model_id, field.key))
				)
				.map((field) => field.key)
			if (fields.length) items.push({ model_id: model.model_id, fields })
		}
	}
	if (selected.size || new Set(selection).size !== selection.length)
		throw new TypeError('Invalid model sync selection')
	return items
}

export type ModelSyncFilters = { search: string; vendor: string; kind: string }
export function filterModelSyncGroups(
	report: ModelSyncReport,
	filters: ModelSyncFilters
): ModelSyncReport['groups'] {
	const query = filters.search.trim().toLowerCase()
	return report.groups
		.filter(
			(group) => filters.vendor === 'all' || group.vendor === filters.vendor
		)
		.flatMap((group) => {
			const models = group.models.filter(
				(model) =>
					(filters.kind === 'all' || model.kind === filters.kind) &&
					[
						model.model_id,
						model.display_name ?? '',
						group.vendor_label,
						group.vendor,
					].some((text) => text.toLowerCase().includes(query))
			)
			return models.length ? [{ ...group, models }] : []
		})
}

/** Explicit bulk selection includes metadata only; prices always need an individual choice. */
export function selectModelSyncMetadata(
	groups: ModelSyncReport['groups'],
	previous: readonly string[]
): string[] {
	const selected = new Set(previous)
	for (const group of groups)
		for (const model of group.models)
			for (const field of model.fields) {
				if (field.key !== 'pricing_profile')
					selected.add(modelSyncSelectionKey(model.model_id, field.key))
			}
	return [...selected]
}
