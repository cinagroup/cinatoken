/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from '../reliability/reliability-range'

export const dashboardSearchSchema = z.object({
	range: z.string().max(32).optional().catch(undefined),
	start_date: z.string().max(32).optional().catch(undefined),
	end_date: z.string().max(32).optional().catch(undefined),
})
export type DashboardSearch = z.infer<typeof dashboardSearchSchema>

/** Bookmarked exact UTC bounds take precedence over a moving preset. */
export function dashboardRangeFromSearch(
	search: DashboardSearch
): ReliabilityRange {
	if (search.start_date && search.end_date) {
		const custom: ReliabilityRange = {
			kind: 'custom',
			startUtc: search.start_date,
			endUtc: search.end_date,
		}
		if (resolveReliabilityRange(custom, 'UTC', new Date())) return custom
		return { kind: 'calendar', preset: 'today' }
	}
	const preset = search.range === '24h' ? '1d' : search.range
	if (preset === 'today' || preset === 'this_week' || preset === 'this_month')
		return { kind: 'calendar', preset }
	if (
		preset === '1h' ||
		preset === '1d' ||
		preset === '7d' ||
		preset === '14d' ||
		preset === '30d'
	)
		return { kind: 'rolling', preset }
	return { kind: 'calendar', preset: 'today' }
}
export function dashboardSearchFromRange(
	range: ReliabilityRange
): DashboardSearch {
	if (range.kind === 'custom')
		return {
			range: 'custom',
			start_date: range.startUtc,
			end_date: range.endUtc,
		}
	return { range: range.preset }
}
