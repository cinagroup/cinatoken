/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { ThemeProvider, useTheme } from '../context/theme-provider'
import { shellMessages } from './shell-messages'

function ThemeState() {
	const theme = useTheme()
	return createElement('p', null, theme.theme + '/' + theme.resolvedTheme)
}

test('account and admin theme provider renders the system fallback when preference cookies cannot be read', () => {
	const documentDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		'document'
	)
	const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: {
			get cookie() {
				throw new Error('Owned preference cookie read denied')
			},
		},
	})
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { matchMedia: () => ({ matches: true }) },
	})
	try {
		const html = renderToString(
			createElement(ThemeProvider, {
				storageKey: 'cinatoken-theme',
				children: createElement(ThemeState),
			})
		)
		assert.equal(html, '<p>system/dark</p>')
	} finally {
		if (documentDescriptor)
			Object.defineProperty(globalThis, 'document', documentDescriptor)
		else Reflect.deleteProperty(globalThis, 'document')
		if (windowDescriptor)
			Object.defineProperty(globalThis, 'window', windowDescriptor)
		else Reflect.deleteProperty(globalThis, 'window')
	}
})

test('the actual private application initializes and switches all four languages with denied optional storage', async () => {
	const descriptors = new Map(
		['document', 'window', 'navigator'].map((name) => [
			name,
			Object.getOwnPropertyDescriptor(globalThis, name),
		])
	)
	const root = { lang: '' }
	let cookieReadsDenied = true
	let cookieValue = ''
	let storageAccessDenied = true
	let storageReadsDenied = false
	let storageWritesDenied = false
	const storedLanguages = new Map<string, string>()
	const optionalStorage = {
		getItem(name: string): string | null {
			if (storageReadsDenied) throw new Error('Owned optional read denied')
			return storedLanguages.get(name) ?? null
		},
		setItem(name: string, value: string): void {
			if (storageWritesDenied) throw new Error('Owned optional write denied')
			storedLanguages.set(name, value)
		},
	}
	const cookies = {
		get cookie(): string {
			if (cookieReadsDenied)
				throw new Error('Owned preference cookie read denied')
			return cookieValue
		},
		set cookie(_value: string) {
			throw new Error('Owned preference cookie write denied')
		},
		documentElement: root,
	}
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: cookies,
	})
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			get localStorage() {
				if (storageAccessDenied)
					throw new Error('Owned optional storage denied')
				return optionalStorage
			},
		},
	})
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { languages: ['ko-KR'], language: 'ko-KR' },
	})
	try {
		const { default: instance } = await import('./i18n')
		assert.equal(instance.isInitialized, true)
		assert.equal(instance.resolvedLanguage, 'ko')
		assert.equal(root.lang, 'ko')
		for (const language of ['en', 'zh', 'ja', 'ko'] as const) {
			await instance.changeLanguage(language)
			assert.equal(root.lang, language)
			assert.equal(instance.resolvedLanguage, language)
			assert.equal(
				instance.t('cinatoken.shell.signIn'),
				shellMessages[language].signIn
			)
		}
		cookieReadsDenied = false
		storageAccessDenied = false
		storedLanguages.set('cinatoken-language', 'ja')
		cookieValue = 'NEXT_LOCALE=zh'
		await instance.changeLanguage()
		assert.equal(instance.resolvedLanguage, 'zh', 'Cookie keeps first priority')
		cookieValue = ''
		storedLanguages.set('cinatoken-language', 'ja')
		await instance.changeLanguage()
		assert.equal(
			instance.resolvedLanguage,
			'ja',
			'Stored preference precedes navigator'
		)
		storageReadsDenied = true
		storageWritesDenied = true
		await instance.changeLanguage()
		assert.equal(
			instance.resolvedLanguage,
			'ko',
			'Revoked reads fall back to navigator'
		)
		await instance.changeLanguage('en')
		assert.equal(
			instance.resolvedLanguage,
			'en',
			'Revoked writes preserve selection'
		)
		assert.equal(root.lang, 'en')
		assert.deepEqual([...storedLanguages.keys()], ['cinatoken-language'])
	} finally {
		for (const [name, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor)
			else Reflect.deleteProperty(globalThis, name)
		}
	}
})
