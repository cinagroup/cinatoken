/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const id = z
	.string()
	.min(1)
	.max(600)
	.refine((value) => value.trim() === value)
const group = z
	.string()
	.min(1)
	.refine((value) => value.trim().length > 0)
const factor = z.number().finite().nonnegative()
export const userChargedCostFactorsSchema = z
	.record(id, z.union([factor, z.record(group, factor)]))
	.nullable()
export type UserChargedCostFactors = z.infer<
	typeof userChargedCostFactorsSchema
>
export type ChargedFactorRow = {
	modelId: string
	/** A missing group keeps the legacy model-wide input contract. */
	routeGroup?: string
	factor: string
}

export function chargedFactorRows(
	value: UserChargedCostFactors
): ChargedFactorRow[] {
	return Object.entries(value ?? {}).flatMap(([modelId, entry]) =>
		typeof entry === 'number'
			? [{ modelId, routeGroup: '*', factor: String(entry) }]
			: Object.entries(entry).map(([routeGroup, value]) => ({
					modelId,
					routeGroup,
					factor: String(value),
				}))
	)
}

/** Match the server's group canonicalization and wildcard-only scalar representation. */
export function normalizeChargedFactorRows(
	rows: readonly ChargedFactorRow[]
): UserChargedCostFactors {
	const models = new Map<string, Map<string, number>>()
	for (const row of rows) {
		const modelId = id.parse(row.modelId.trim())
		const routeGroup = group.parse((row.routeGroup ?? '*').trim().toLowerCase())
		const raw = row.factor.trim()
		if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(raw))
			throw new Error('Invalid factor')
		const value = factor.parse(Number(raw))
		const groups = models.get(modelId) ?? new Map<string, number>()
		if (groups.has(routeGroup)) throw new Error('Duplicate model/group')
		groups.set(routeGroup, value)
		models.set(modelId, groups)
	}
	if (!models.size) return null
	return Object.fromEntries(
		[...models].map(([modelId, groups]) => [
			modelId,
			groups.size === 1 && groups.has('*')
				? groups.get('*')!
				: Object.fromEntries(groups),
		])
	)
}

export function chargedFactorsEqual(
	left: UserChargedCostFactors,
	right: UserChargedCostFactors
): boolean {
	function canonical(value: UserChargedCostFactors): string {
		const normalized = normalizeChargedFactorRows(chargedFactorRows(value))
		return JSON.stringify(
			Object.entries(normalized ?? {})
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [
					key,
					typeof entry === 'number'
						? entry
						: Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
				])
		)
	}
	return canonical(left) === canonical(right)
}
