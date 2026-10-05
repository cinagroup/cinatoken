/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { getI18n } from 'react-i18next'
import { publicAuthMessages } from '../auth/messages'
import { createPublicI18n } from './public-i18n'
import { PUBLIC_LOCALES } from './public-location'

test('public auth translations initialize per request without replacing the global React i18n instance', () => {
	const globalInstance = getI18n()
	const instances = PUBLIC_LOCALES.map(createPublicI18n)
	assert.equal(new Set(instances).size, 4)
	for (const [index, locale] of PUBLIC_LOCALES.entries()) {
		const instance = instances[index]
		assert.equal(instance.isInitialized, true)
		assert.equal(instance.language, locale)
		assert.equal(
			instance.t('cinatoken.publicAuth.loading'),
			publicAuthMessages[locale].loading
		)
		assert.equal(
			instance.t('cinatoken.publicAuth.errors.sessionUnavailable'),
			publicAuthMessages[locale].errors.sessionUnavailable
		)
	}
	assert.equal(getI18n(), globalInstance)
	void instances[0].changeLanguage('ja')
	assert.equal(instances[1].language, 'zh')
	assert.equal(instances[2].language, 'ja')
	assert.equal(instances[3].language, 'ko')
})
