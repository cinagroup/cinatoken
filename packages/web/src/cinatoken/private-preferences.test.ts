/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { act, createElement, StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { ThemeProvider, useTheme } from '../context/theme-provider'
import { installPrivateLanguageRestoration } from './private-language-restoration'
import { shellMessages } from './shell-messages'

function ThemeState() {
	const theme = useTheme()
	return createElement('p', null, theme.theme + '/' + theme.resolvedTheme)
}

class OwnedPreferenceDocument extends EventTarget {
	readDenied = false
	writeDenied = false
	silentWriteDenial = false
	readonly cookies = new Map<string, string>()
	readonly writes: string[] = []
	readonly classes = new Set<string>(['retained-shell'])
	readonly nodeType = 9
	readonly activeElement = null
	defaultView?: OwnedPreferenceBrowser
	readonly documentElement = {
		classList: {
			remove: (...names: string[]) => {
				for (const name of names) this.classes.delete(name)
			},
			add: (name: string) => this.classes.add(name),
		},
	}

	get cookie(): string {
		if (this.readDenied) throw new Error('Owned cookie read denied')
		return [...this.cookies]
			.map(([name, value]) => `${name}=${value}`)
			.join('; ')
	}

	set cookie(value: string) {
		this.writes.push(value)
		if (this.writeDenied) throw new Error('Owned cookie write denied')
		if (this.silentWriteDenial) return
		const [assignment] = value.split(';')
		const boundary = assignment!.indexOf('=')
		const name = assignment!.slice(0, boundary)
		if (/max-age=0(?:;|$)/i.test(value)) this.cookies.delete(name)
		else this.cookies.set(name, assignment!.slice(boundary + 1))
	}
}

class OwnedPreferenceEvents extends EventTarget {
	private readonly listeners = new Map<
		string,
		Set<EventListenerOrEventListenerObject>
	>()

	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null
	): void {
		if (!listener) return
		const existing =
			this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
		existing.add(listener)
		this.listeners.set(type, existing)
		super.addEventListener(type, listener)
	}

	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null
	): void {
		if (!listener) return
		this.listeners.get(type)?.delete(listener)
		super.removeEventListener(type, listener)
	}

	listenerCount(type: string): number {
		return this.listeners.get(type)?.size ?? 0
	}
}

class OwnedPreferenceBrowser extends OwnedPreferenceEvents {
	readonly document = new OwnedPreferenceDocument()
	readonly media = Object.assign(new OwnedPreferenceEvents(), {
		matches: false,
	})
	readonly HTMLIFrameElement = class {}

	constructor() {
		super()
		this.document.defaultView = this
	}

	matchMedia(query: string) {
		assert.equal(query, '(prefers-color-scheme: dark)')
		return this.media
	}
}

function installOwnedBrowser(browser: OwnedPreferenceBrowser): () => void {
	const globals: Record<string, unknown> = {
		window: browser,
		document: browser.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	}
	const descriptors = Object.keys(globals).map(
		(name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
	)
	for (const [name, value] of Object.entries(globals))
		Object.defineProperty(globalThis, name, { configurable: true, value })
	return () => {
		for (const [name, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor)
			else Reflect.deleteProperty(globalThis, name)
		}
	}
}

test('mounted private theme restores changed shared cookies and current system media without remounting or writing unrelated cookies', async () => {
	const browser = new OwnedPreferenceBrowser()
	browser.document.cookies.set('cinatoken-theme', 'light')
	browser.document.cookies.set('owned-auth-cookie', 'untouched')
	const restoreGlobals = installOwnedBrowser(browser)
	const container = Object.assign(new EventTarget(), {
		nodeType: 1,
		tagName: 'DIV',
		ownerDocument: browser.document,
		textContent: '',
	})
	const root = createRoot(container as unknown as HTMLElement)
	let state: ReturnType<typeof useTheme> | undefined
	function Probe() {
		const current = useTheme()
		useEffect(() => {
			state = current
		}, [current])
		return null
	}
	try {
		await act(async () =>
			root.render(
				createElement(
					StrictMode,
					null,
					createElement(ThemeProvider, {
						storageKey: 'cinatoken-theme',
						children: createElement(Probe),
					})
				)
			)
		)
		assert.equal(state!.theme, 'light')
		assert.equal(state!.resolvedTheme, 'light')
		browser.document.cookies.set('cinatoken-theme', 'dark')
		await act(async () => {
			browser.dispatchEvent(new Event('pageshow'))
			browser.dispatchEvent(new Event('pageshow'))
		})
		assert.equal(
			state!.theme,
			'dark',
			'A resumed private document adopts the externally changed shared cookie'
		)
		assert.equal(state!.resolvedTheme, 'dark')
		assert.equal(browser.document.classes.has('dark'), true)
		await act(async () => browser.media.dispatchEvent(new Event('change')))
		assert.equal(
			state!.resolvedTheme,
			'dark',
			'Explicit choices do not follow system appearance'
		)
		browser.document.cookies.set('cinatoken-theme', 'system')
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(state!.theme, 'system')
		assert.equal(state!.resolvedTheme, 'light')
		// OS changes while the document is frozen need not deliver a change event.
		browser.media.matches = true
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(state!.resolvedTheme, 'dark')
		browser.media.matches = false
		await act(async () => browser.media.dispatchEvent(new Event('change')))
		assert.equal(
			state!.resolvedTheme,
			'light',
			'System preference still follows ordinary media changes'
		)
		browser.document.cookies.delete('cinatoken-theme')
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(
			state!.theme,
			'system',
			'A readable deleted preference uses the configured default'
		)
		assert.equal(browser.document.classes.has('retained-shell'), true)
		assert.equal(browser.document.cookies.get('owned-auth-cookie'), 'untouched')
		assert.deepEqual(browser.document.writes, [])
		assert.equal(
			browser.listenerCount('pageshow'),
			1,
			'StrictMode retains one restore listener'
		)
		assert.equal(browser.media.listenerCount('change'), 1)
	} finally {
		await act(async () => root.unmount())
		assert.equal(browser.listenerCount('pageshow'), 0)
		assert.equal(browser.media.listenerCount('change'), 0)
		restoreGlobals()
	}
})

test('mounted private theme preserves this document choice across denied cookie reads, denied writes and unchanged stale persisted values', async () => {
	const browser = new OwnedPreferenceBrowser()
	browser.document.cookies.set('cinatoken-theme', 'light')
	const restoreGlobals = installOwnedBrowser(browser)
	const container = Object.assign(new EventTarget(), {
		nodeType: 1,
		tagName: 'DIV',
		ownerDocument: browser.document,
		textContent: '',
	})
	const root = createRoot(container as unknown as HTMLElement)
	let state: ReturnType<typeof useTheme> | undefined
	function Probe() {
		const current = useTheme()
		useEffect(() => {
			state = current
		}, [current])
		return null
	}
	try {
		await act(async () =>
			root.render(
				createElement(ThemeProvider, {
					storageKey: 'cinatoken-theme',
					children: createElement(Probe),
				})
			)
		)
		browser.document.writeDenied = true
		await act(async () => state!.setTheme('dark'))
		assert.equal(state!.theme, 'dark')
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(
			state!.theme,
			'dark',
			'A rejected write does not restore the stale light cookie'
		)
		browser.document.readDenied = true
		await act(async () => state!.setTheme('system'))
		browser.media.matches = true
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(state!.theme, 'system')
		assert.equal(
			state!.resolvedTheme,
			'dark',
			'Unreadable cookies do not prevent media restoration'
		)
		browser.document.readDenied = false
		browser.document.writeDenied = false
		browser.document.silentWriteDenial = true
		await act(async () => state!.setTheme('dark'))
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(
			state!.theme,
			'dark',
			'Silent denial also preserves the current choice'
		)
		browser.document.cookies.set('cinatoken-theme', 'invalid-external')
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(
			state!.theme,
			'system',
			'A changed readable invalid cookie falls back to the configured default'
		)
		await act(async () => state!.setTheme('light'))
		await act(async () => state!.resetTheme())
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(state!.theme, 'system')
		assert.equal(state!.resolvedTheme, 'dark')
	} finally {
		await act(async () => root.unmount())
		restoreGlobals()
	}
})

test('a first readable theme cookie after denied startup reads establishes a baseline without erasing the document choice', async () => {
	const browser = new OwnedPreferenceBrowser()
	browser.document.cookies.set('cinatoken-theme', 'light')
	browser.document.readDenied = true
	browser.document.writeDenied = true
	const restoreGlobals = installOwnedBrowser(browser)
	const container = Object.assign(new EventTarget(), {
		nodeType: 1,
		tagName: 'DIV',
		ownerDocument: browser.document,
		textContent: '',
	})
	const root = createRoot(container as unknown as HTMLElement)
	let state: ReturnType<typeof useTheme> | undefined
	function Probe() {
		const current = useTheme()
		useEffect(() => {
			state = current
		}, [current])
		return null
	}
	try {
		await act(async () =>
			root.render(
				createElement(ThemeProvider, {
					storageKey: 'cinatoken-theme',
					children: createElement(Probe),
				})
			)
		)
		assert.equal(state!.theme, 'system')
		await act(async () => state!.setTheme('dark'))
		browser.document.readDenied = false
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(
			state!.theme,
			'dark',
			'The first readable old light cookie is not evidence of an external change'
		)
		assert.equal(state!.resolvedTheme, 'dark')
		browser.document.cookies.set('cinatoken-theme', 'system')
		browser.media.matches = true
		await act(async () => browser.dispatchEvent(new Event('pageshow')))
		assert.equal(
			state!.theme,
			'system',
			'A later different readable cookie is an observed external change'
		)
		assert.equal(state!.resolvedTheme, 'dark')
	} finally {
		await act(async () => root.unmount())
		restoreGlobals()
	}
})

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
	const attemptedCookieWrites: string[] = []
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
		set cookie(value: string) {
			attemptedCookieWrites.push(value)
			throw new Error('Owned preference cookie write denied')
		},
		documentElement: root,
	}
	const browser = Object.assign(new OwnedPreferenceEvents(), {
		location: { pathname: '/account' },
	})
	Object.defineProperty(browser, 'localStorage', {
		get() {
			if (storageAccessDenied) throw new Error('Owned optional storage denied')
			return optionalStorage
		},
	})
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: cookies,
	})
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: browser,
	})
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { languages: ['ko-KR'], language: 'ko-KR' },
	})
	let disposeRestoration: (() => void) | undefined
	try {
		const { default: instance } = await import('./i18n')
		// Match an effect cleanup/remount; the source installer owns its listeners.
		const firstInstallation = installPrivateLanguageRestoration(
			instance,
			browser as unknown as Window
		)
		firstInstallation()
		firstInstallation()
		disposeRestoration = installPrivateLanguageRestoration(
			instance,
			browser as unknown as Window
		)
		assert.equal(browser.listenerCount('pageshow'), 1)
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
		await instance.changeLanguage('ja')
		cookieReadsDenied = false
		cookieValue = 'NEXT_LOCALE=zh'
		browser.dispatchEvent(new Event('pageshow'))
		assert.equal(
			instance.resolvedLanguage,
			'ja',
			'The first readable old locale after denied startup reads only establishes a baseline'
		)
		cookieValue = 'NEXT_LOCALE=ko'
		browser.dispatchEvent(new Event('pageshow'))
		assert.equal(
			instance.resolvedLanguage,
			'ko',
			'A subsequent different readable locale restores an observed external selection'
		)
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
		for (const language of ['zh', 'ja', 'ko', 'en'] as const) {
			cookieValue = `NEXT_LOCALE=${language}`
			browser.dispatchEvent(new Event('pageshow'))
			assert.equal(
				instance.resolvedLanguage,
				language,
				'A resumed non-URL private page follows the current shared locale'
			)
			assert.equal(root.lang, language)
			assert.equal(
				instance.t('cinatoken.shell.signIn'),
				shellMessages[language].signIn
			)
		}
		cookieValue = 'NEXT_LOCALE=ja'
		browser.dispatchEvent(new Event('pageshow'))
		await instance.changeLanguage('en')
		browser.dispatchEvent(new Event('pageshow'))
		assert.equal(
			instance.resolvedLanguage,
			'en',
			'An unchanged stale cookie after a rejected write must not erase this document selection'
		)
		cookieReadsDenied = true
		cookieValue = 'NEXT_LOCALE=zh'
		browser.dispatchEvent(new Event('pageshow'))
		assert.equal(
			instance.resolvedLanguage,
			'en',
			'Denied restore reads preserve the current language'
		)
		cookieReadsDenied = false
		browser.dispatchEvent(new Event('pageshow'))
		assert.equal(
			instance.resolvedLanguage,
			'zh',
			'Readable external changes resume following preferences'
		)
		cookieValue = ''
		browser.dispatchEvent(new Event('pageshow'))
		assert.equal(
			instance.resolvedLanguage,
			'ko',
			'A deleted readable cookie uses the existing detector fallback'
		)
		browser.location.pathname = '/zh/models'
		cookieValue = 'NEXT_LOCALE=ja'
		browser.dispatchEvent(new Event('pageshow'))
		assert.equal(
			instance.resolvedLanguage,
			'ko',
			'The private observer cannot replace a public URL locale'
		)
		disposeRestoration()
		assert.equal(browser.listenerCount('pageshow'), 0)
		browser.location.pathname = '/admin'
		browser.dispatchEvent(new Event('pageshow'))
		assert.equal(
			instance.resolvedLanguage,
			'ko',
			'Disposed private observers cannot mutate a later document'
		)
		assert.ok(
			attemptedCookieWrites.every((value) => value.startsWith('NEXT_LOCALE=')),
			'Language persistence only writes its owned preference cookie'
		)
	} finally {
		disposeRestoration?.()
		for (const [name, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor)
			else Reflect.deleteProperty(globalThis, name)
		}
	}
})
