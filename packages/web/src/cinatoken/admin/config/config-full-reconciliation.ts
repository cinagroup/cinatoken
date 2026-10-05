/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type {
	AdminConfigBillingCurrency,
	AdminConfigOverview,
	AdminConfigRouteStrategy,
	AdminConfigWebhookChannel,
} from './config-contracts'

/** Pending metadata contains no webhook URL; the candidate remains in a component ref only. */
export type PendingConfigWrite =
	| { kind: 'timezone'; value: string; acknowledged: boolean }
	| {
			kind: 'currency'
			value: AdminConfigBillingCurrency
			acknowledged: boolean
	  }
	| { kind: 'strategy'; value: AdminConfigRouteStrategy; acknowledged: boolean }
	| {
			kind: 'webhook-clear'
			channel: AdminConfigWebhookChannel
			acknowledged: boolean
	  }
	| {
			kind: 'webhook-replace'
			channel: AdminConfigWebhookChannel
			acknowledged: boolean
	  }

export type ConfigReconciliation =
	'matches' | 'differs' | 'requires-verification'

/** A configured bit cannot prove which webhook URL survived an uncertain replace. */
export function reconcileConfigWrite(
	pending: PendingConfigWrite,
	overview: AdminConfigOverview,
	verifiedMatch?: boolean,
	candidateAvailable = true
): ConfigReconciliation {
	if (pending.kind === 'webhook-replace') {
		if (verifiedMatch === true) return 'matches'
		if (verifiedMatch === false) return 'differs'
		if (!candidateAvailable) return 'requires-verification'
		if (!pending.acknowledged) return 'requires-verification'
		return overview.webhooks[pending.channel].configured ? 'matches' : 'differs'
	}
	if (pending.kind === 'webhook-clear')
		return overview.webhooks[pending.channel].configured ? 'differs' : 'matches'
	if (pending.kind === 'timezone')
		return overview.businessTimezone.value === pending.value &&
			overview.businessTimezone.source === 'configured'
			? 'matches'
			: 'differs'
	if (pending.kind === 'currency')
		return overview.billingCurrency.value === pending.value &&
			overview.billingCurrency.source === 'configured'
			? 'matches'
			: 'differs'
	return overview.routeStrategy.value === pending.value &&
		overview.routeStrategy.source === 'configured'
		? 'matches'
		: 'differs'
}
