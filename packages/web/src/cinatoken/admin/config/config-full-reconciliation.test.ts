/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AdminConfigOverview } from './config-contracts'
import { reconcileConfigWrite } from './config-full-reconciliation'

const overview: AdminConfigOverview = {
	businessTimezone: { value: 'UTC', source: 'configured', revision: 'legacy' },
	billingCurrency: { value: 'CNY', source: 'configured', revision: 'legacy' },
	routeStrategy: {
		value: 'weighted_random',
		source: 'configured',
		revision: 'legacy',
	},
	webhooks: {
		wecom: { configured: true, revision: 'legacy' },
		feishu: { configured: false, revision: null },
	},
	canWrite: true,
	canReveal: true,
}

test('a configured webhook cannot confirm an uncertain replacement without explicit exact verification', () => {
	const pending = {
		kind: 'webhook-replace',
		channel: 'wecom',
		acknowledged: false,
	} as const
	assert.equal(reconcileConfigWrite(pending, overview), 'requires-verification')
	assert.equal(reconcileConfigWrite(pending, overview, true), 'matches')
	assert.equal(reconcileConfigWrite(pending, overview, false), 'differs')
	assert.equal(
		reconcileConfigWrite({ ...pending, acknowledged: true }, overview),
		'matches'
	)
	assert.equal(
		reconcileConfigWrite(
			{ ...pending, acknowledged: true },
			overview,
			undefined,
			false
		),
		'requires-verification'
	)
	assert.equal(
		reconcileConfigWrite(
			{ ...pending, acknowledged: true },
			{
				...overview,
				webhooks: {
					...overview.webhooks,
					wecom: { configured: false, revision: 'legacy' },
				},
			}
		),
		'differs'
	)
	assert.equal(JSON.stringify(pending).includes('https://'), false)
})

test('safe overview can reconcile non-secret values and explicit clear without inferring a secret', () => {
	assert.equal(
		reconcileConfigWrite(
			{ kind: 'currency', value: 'CNY', acknowledged: false },
			overview
		),
		'matches'
	)
	assert.equal(
		reconcileConfigWrite(
			{ kind: 'currency', value: 'USD', acknowledged: false },
			overview
		),
		'differs'
	)
	assert.equal(
		reconcileConfigWrite(
			{ kind: 'timezone', value: 'UTC', acknowledged: false },
			overview
		),
		'matches'
	)
	assert.equal(
		reconcileConfigWrite(
			{ kind: 'strategy', value: 'hash_affinity', acknowledged: false },
			overview
		),
		'differs'
	)
	assert.equal(
		reconcileConfigWrite(
			{ kind: 'webhook-clear', channel: 'feishu', acknowledged: false },
			overview
		),
		'matches'
	)
	assert.equal(
		reconcileConfigWrite(
			{ kind: 'webhook-clear', channel: 'wecom', acknowledged: false },
			overview
		),
		'differs'
	)
})

test('effective defaults do not prove a missing or invalid value was written', () => {
	const defaults: AdminConfigOverview = {
		...overview,
		businessTimezone: { value: 'UTC', source: 'missing', revision: null },
		billingCurrency: { value: 'USD', source: 'invalid', revision: 'legacy' },
		routeStrategy: {
			value: 'hash_affinity',
			source: 'missing',
			revision: null,
		},
	}
	assert.equal(
		reconcileConfigWrite(
			{ kind: 'timezone', value: 'UTC', acknowledged: false },
			defaults
		),
		'differs'
	)
	assert.equal(
		reconcileConfigWrite(
			{ kind: 'currency', value: 'USD', acknowledged: false },
			defaults
		),
		'differs'
	)
	assert.equal(
		reconcileConfigWrite(
			{ kind: 'strategy', value: 'hash_affinity', acknowledged: false },
			defaults
		),
		'differs'
	)
})
