/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	reliabilityDisplayResponseSchema,
	type ReliabilityDisplay,
} from '../reliability/reliability-contracts'

export type UserDisplay = Omit<
	ReliabilityDisplay,
	'timezone' | 'timezoneSource'
> & {
	timezone: string | null
	timezoneSource: ReliabilityDisplay['timezoneSource'] | null
}

const fields = reliabilityDisplayResponseSchema.shape.data.shape
/** Rolling deployments may omit either field. Never cache the full overview. */
export const usersDisplayResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		businessTimezone: fields.businessTimezone.nullable().catch(null),
		billingCurrency: fields.billingCurrency.nullable().catch(null),
	}),
})

export function projectUserDisplay(
	data: z.infer<typeof usersDisplayResponseSchema>['data']
): UserDisplay {
	const result: UserDisplay = {
		timezone: null,
		timezoneSource: null,
		currency: null,
		currencySource: null,
	}
	const zone = data.businessTimezone
	if (zone) {
		const fallback = zone.source === 'missing' || zone.source === 'invalid'
		try {
			new Intl.DateTimeFormat('en-US', { timeZone: zone.value })
			if (!fallback || zone.value === 'UTC') {
				result.timezone = zone.value
				result.timezoneSource = zone.source
			}
		} catch {
			// Keep a verified currency even when the timezone cannot be verified.
		}
	}
	const billing = data.billingCurrency
	if (billing?.source === 'missing' && billing.value === 'USD') {
		result.currency = 'USD'
		result.currencySource = 'missing'
	} else if (
		billing?.source === 'configured' &&
		(billing.value === 'USD' || billing.value === 'CNY')
	) {
		result.currency = billing.value
		result.currencySource = 'configured'
	}
	return result
}
