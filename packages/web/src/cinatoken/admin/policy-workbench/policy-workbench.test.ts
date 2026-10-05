/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateDataPolicySearch } from '../data-policies/data-policy-search'
import {
	policyWorkbenchLocales,
	policyWorkbenchMessages,
} from './policy-workbench-messages'
import {
	readPolicyWorkbenchSearch,
	serializePolicyWorkbenchSearch,
} from './policy-workbench-search'

test('legacy policy URL preserves ambiguous parameters and uses the same canonical Web filters', () => {
	assert.deepEqual(
		readPolicyWorkbenchSearch(
			'?q=first&q=second&status=verified&status=expired'
		),
		{ q: ['first', 'second'], status: ['verified', 'expired'] }
	)
	assert.deepEqual(
		validateDataPolicySearch(
			readPolicyWorkbenchSearch(
				'?q=first&q=second&status=verified&status=expired'
			)
		),
		{ q: '', status: 'all' }
	)
	for (const filters of [
		{ q: 'all', status: 'all' },
		{ q: '供应商 / سياسة', status: 'verified' },
		{ q: 'a&status=expired', status: 'unknown' },
	] as const) {
		const search = serializePolicyWorkbenchSearch(filters)
		assert.deepEqual(
			validateDataPolicySearch(readPolicyWorkbenchSearch(search)),
			filters
		)
	}
	assert.equal(serializePolicyWorkbenchSearch({ q: '', status: 'all' }), '')
})

for (const locale of policyWorkbenchLocales)
	test(
		'actual legacy policy resource tree resolves all policy/recovery/preview namespaces: ' +
			locale,
		async () => {
			const runtime = createInstance()
			await runtime.init({
				lng: locale,
				fallbackLng: false,
				resources: {
					[locale]: { translation: policyWorkbenchMessages(locale) },
				},
				interpolation: { escapeValue: false },
			})
			for (const key of [
				'cinatoken.bridge.checking',
				'cinatoken.adminDomain.review',
				'cinatoken.adminDomain.unknown',
				'cinatoken.adminPresets.title',
				'cinatoken.adminGuardrails.title',
				'cinatoken.adminDataPolicies.title',
				'cinatoken.account.guardrails.previewAction',
				'cinatoken.account.guardrails.previewConflict',
			]) {
				assert.equal(runtime.exists(key), true, key)
				assert.notEqual(runtime.t(key), key)
				assert.ok(runtime.t(key).trim())
			}
			const key = 'cinatoken.adminPresets.metadataTitle'
			assert.equal(runtime.exists(key), true)
			const interpolated = runtime.t(key, { name: 'Policy example' })
			assert.ok(interpolated.includes('Policy example'))
			assert.equal(interpolated.includes('{{'), false)
		}
	)

test('the actual Web i18next registration resolves every policy domain and preview in all four languages', async () => {
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		'document'
	)
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: { documentElement: { lang: '' }, cookie: '' },
	})
	try {
		const { default: runtime } = await import('../../i18n')
		if (!runtime.isInitialized)
			await new Promise<void>((resolve) => runtime.once('initialized', resolve))
		for (const locale of policyWorkbenchLocales) {
			await runtime.changeLanguage(locale)
			for (const key of [
				'cinatoken.adminPresets.title',
				'cinatoken.adminGuardrails.title',
				'cinatoken.adminDataPolicies.title',
				'cinatoken.account.guardrails.previewAction',
				'cinatoken.account.guardrails.previewConflict',
				'cinatoken.adminDomain.review',
				'cinatoken.adminDomain.reviewFailed',
			]) {
				assert.equal(runtime.exists(key), true, locale + ': ' + key)
				assert.notEqual(runtime.t(key), key)
				assert.ok(runtime.t(key).trim())
			}
			const title = runtime.t('cinatoken.adminPresets.metadataTitle', {
				name: 'Policy example',
			})
			assert.ok(title.includes('Policy example'))
			assert.equal(title.includes('{{'), false)
		}
	} finally {
		if (previousDocument)
			Object.defineProperty(globalThis, 'document', previousDocument)
		else Reflect.deleteProperty(globalThis, 'document')
	}
})
