/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { PUBLIC_LOCALES, localizePublicHref } from './public-location'
import { publicPreferencesScript } from './public-preferences'

type PreferenceEvent = { target: unknown }
type Listener = (event: PreferenceEvent) => void
type Controller = { syncControls: () => void; dispose: () => void }

class OwnedEvents {
	private listeners = new Map<string, Set<Listener>>()
	readonly registrations: { type: string; capture: boolean }[] = []

	addEventListener(type: string, listener: Listener, capture = false): void {
		this.registrations.push({ type, capture })
		const listeners = this.listeners.get(type) ?? new Set<Listener>()
		listeners.add(listener)
		this.listeners.set(type, listeners)
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener)
	}

	dispatch(type: string, target: unknown = null): void {
		for (const listener of [...(this.listeners.get(type) ?? [])])
			listener({ target })
	}

	listenerCount(type: string): number {
		return this.listeners.get(type)?.size ?? 0
	}
}

class OwnedElement {
	readonly attributes = new Map<string, string>()
	value: string

	constructor(kind: string | null, value: string) {
		this.value = value
		if (kind !== null)
			this.attributes.set('data-cinatoken-public-preference', kind)
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null
	}
}

class OwnedSelect extends OwnedElement {
	readonly defaultValue: string

	constructor(kind: string | null, value: string) {
		super(kind, value)
		this.defaultValue = value
	}
}

class OwnedRoot {
	readonly nodes = new Set<unknown>()

	contains(node: unknown): boolean {
		return this.nodes.has(node)
	}

	querySelectorAll(selector: string): OwnedSelect[] {
		const match = /^select\[([^=]+)="([^"]+)"\]$/.exec(selector)
		assert.ok(match, `Unsupported owned DOM selector: ${selector}`)
		return [...this.nodes].filter(
			(node): node is OwnedSelect =>
				node instanceof OwnedSelect && node.getAttribute(match[1]!) === match[2]
		)
	}
}

class OwnedDocument extends OwnedEvents {
	root: OwnedRoot | null = null
	readBlocked = false
	writeBlocked = false
	readonly cookieValues = new Map<string, string>()
	readonly cookieWrites: string[] = []
	readonly classes = new Set(['public-page'])
	readonly documentElement = {
		classList: {
			remove: (...classes: string[]) => {
				for (const value of classes) this.classes.delete(value)
			},
			add: (value: string) => this.classes.add(value),
		},
	}

	get cookie(): string {
		if (this.readBlocked) throw new Error('Owned cookie read rejected')
		return [...this.cookieValues]
			.map(([name, value]) => `${name}=${value}`)
			.join('; ')
	}

	set cookie(value: string) {
		this.cookieWrites.push(value)
		if (this.writeBlocked) throw new Error('Owned cookie write rejected')
		const assignment = value.split(';', 1)[0]!
		const boundary = assignment.indexOf('=')
		assert.ok(boundary > 0, 'Owned cookie assignment requires a name')
		this.cookieValues.set(
			assignment.slice(0, boundary),
			assignment.slice(boundary + 1)
		)
	}

	getElementById(id: string): OwnedRoot | null {
		return id === 'root' ? this.root : null
	}
}

class OwnedMedia extends OwnedEvents {
	matches: boolean

	constructor(matches: boolean) {
		super()
		this.matches = matches
	}

	setMatches(matches: boolean): void {
		this.matches = matches
		this.dispatch('change')
	}
}

class OwnedBrowser extends OwnedEvents {
	readonly HTMLSelectElement = OwnedSelect
	readonly document = new OwnedDocument()
	readonly media: OwnedMedia
	readonly mediaQueries: string[] = []
	readonly navigations: string[] = []
	cinatokenPublicPreferences?: Controller
	readonly location: {
		pathname: string
		search: string
		hash: string
		assign: (href: string) => void
	}

	constructor(options: { href?: string; dark?: boolean; theme?: string } = {}) {
		super()
		const url = new URL(options.href ?? 'https://public.example/en')
		this.media = new OwnedMedia(options.dark ?? false)
		this.location = {
			pathname: url.pathname,
			search: url.search,
			hash: url.hash,
			assign: (href) => this.navigations.push(href),
		}
		if (options.theme !== undefined)
			this.document.cookieValues.set('cinatoken-theme', options.theme)
	}

	matchMedia(query: string): OwnedMedia {
		this.mediaQueries.push(query)
		assert.equal(query, '(prefers-color-scheme: dark)')
		return this.media
	}
}

function install(browser: OwnedBrowser): Controller {
	runInNewContext(
		publicPreferencesScript,
		{ window: browser },
		{ timeout: 1000 }
	)
	assert.ok(browser.cinatokenPublicPreferences)
	return browser.cinatokenPublicPreferences
}

function mount(browser: OwnedBrowser) {
	const root = new OwnedRoot()
	const theme = new OwnedSelect('theme', 'system')
	const locale = new OwnedSelect('locale', 'en')
	root.nodes.add(theme)
	root.nodes.add(locale)
	browser.document.root = root
	return { root, theme, locale }
}

function appearance(browser: OwnedBrowser): string {
	const classes = browser.document.classes
	assert.equal(classes.has('public-page'), true)
	assert.notEqual(classes.has('light'), classes.has('dark'))
	return classes.has('dark') ? 'dark' : 'light'
}

function choose(
	browser: OwnedBrowser,
	select: OwnedSelect,
	value: string
): void {
	select.value = value
	browser.document.dispatch('change', select)
}

test('fixed inline code initializes saved or system appearance before root exists without writing cookies', () => {
	for (const scenario of [
		{ dark: false, expected: 'light' },
		{ dark: true, expected: 'dark' },
		{ theme: 'dark', dark: false, expected: 'dark' },
		{ theme: 'light', dark: true, expected: 'light' },
		{ theme: 'system', dark: true, expected: 'dark' },
		{ theme: 'invalid', dark: true, expected: 'dark' },
	]) {
		const browser = new OwnedBrowser(scenario)
		browser.document.cookieValues.set('cinatoken-theme-extra', 'light')
		install(browser)
		assert.equal(browser.document.root, null)
		assert.equal(appearance(browser), scenario.expected)
		assert.deepEqual(browser.document.cookieWrites, [])
		assert.deepEqual(browser.navigations, [])
		assert.deepEqual(browser.document.registrations, [
			{ type: 'change', capture: true },
		])
	}
})

test('root synchronization restores live values while preserving rendered defaults and URL locale authority', () => {
	const browser = new OwnedBrowser({
		theme: 'dark',
		href: 'https://public.example/ja/models',
	})
	browser.document.cookieValues.set('NEXT_LOCALE', 'ko')
	const controller = install(browser)
	const controls = mount(browser)
	controller.syncControls()
	assert.equal(controls.theme.value, 'dark')
	assert.equal(controls.theme.defaultValue, 'system')
	assert.equal(controls.locale.value, 'ja')
	assert.equal(controls.locale.defaultValue, 'en')
	assert.deepEqual(
		[...controls.theme.attributes],
		[['data-cinatoken-public-preference', 'theme']]
	)
	assert.deepEqual(browser.document.cookieWrites, [])
})

test('captured native theme input immediately persists and survives later synchronization', () => {
	const browser = new OwnedBrowser()
	const controls = mount(browser)
	const controller = install(browser)
	for (const value of ['dark', 'light', 'system']) {
		choose(browser, controls.theme, value)
		assert.equal(appearance(browser), value === 'dark' ? 'dark' : 'light')
		assert.equal(controls.theme.value, value)
		assert.equal(
			browser.document.cookieWrites.at(-1),
			`cinatoken-theme=${value}; Path=/; SameSite=Lax; Max-Age=31536000`
		)
		controller.syncControls()
		assert.equal(controls.theme.value, value)
	}
	assert.equal(browser.document.cookieWrites.length, 3)
	assert.deepEqual(browser.navigations, [])
})

test('cookie read and write denial preserve current theme through media, sync and pageshow', () => {
	for (const blocked of ['read', 'write', 'both']) {
		const browser = new OwnedBrowser({ theme: 'light', dark: false })
		browser.document.readBlocked = blocked !== 'write'
		browser.document.writeBlocked = blocked !== 'read'
		const controls = mount(browser)
		const controller = install(browser)
		choose(browser, controls.theme, 'dark')
		browser.media.setMatches(false)
		controller.syncControls()
		browser.dispatch('pageshow')
		assert.equal(appearance(browser), 'dark', blocked)
		assert.equal(controls.theme.value, 'dark', blocked)
		assert.deepEqual(browser.navigations, [])
	}
	const browser = new OwnedBrowser({ theme: 'dark', dark: true })
	const controls = mount(browser)
	const controller = install(browser)
	choose(browser, controls.theme, 'light')
	browser.document.readBlocked = true
	browser.dispatch('pageshow')
	controller.syncControls()
	assert.equal(
		appearance(browser),
		'light',
		'A newly rejected read must not become an absent-cookie reset'
	)
	assert.equal(controls.theme.value, 'light')
})

test('system tracks OS changes but explicit appearance does not; pageshow adopts readable external cookie changes', () => {
	const browser = new OwnedBrowser()
	const controls = mount(browser)
	install(browser)
	browser.media.setMatches(true)
	assert.equal(appearance(browser), 'dark')
	assert.equal(controls.theme.value, 'system')
	choose(browser, controls.theme, 'light')
	browser.media.setMatches(true)
	assert.equal(appearance(browser), 'light')
	choose(browser, controls.theme, 'dark')
	browser.media.setMatches(false)
	assert.equal(appearance(browser), 'dark')
	const writes = browser.document.cookieWrites.length
	browser.document.cookieValues.set('cinatoken-theme', 'light')
	browser.dispatch('pageshow')
	assert.equal(appearance(browser), 'light')
	assert.equal(controls.theme.value, 'light')
	browser.document.cookieValues.delete('cinatoken-theme')
	browser.media.setMatches(true)
	browser.dispatch('pageshow')
	assert.equal(appearance(browser), 'dark')
	assert.equal(controls.theme.value, 'system')
	assert.equal(browser.document.cookieWrites.length, writes)
})

test('all four native locale choices preserve public resource, query and fragment exactly like existing href policy', () => {
	for (const current of PUBLIC_LOCALES) {
		for (const desired of PUBLIC_LOCALES) {
			for (const bare of [
				'',
				'/models',
				'/models/Vendor/fixture-model',
				'/providers',
				'/compare',
				'/chat',
				'/rankings',
				'/benchmarks',
			]) {
				const path = `/${current}${bare}?q=x&vendors=%5B%22Vendor%22%5D#pricing`
				const browser = new OwnedBrowser({
					href: `https://public.example${path}`,
				})
				const controls = mount(browser)
				install(browser)
				choose(browser, controls.locale, desired)
				assert.deepEqual(
					browser.navigations,
					current === desired ? [] : [localizePublicHref(path, desired)]
				)
				assert.deepEqual(browser.document.cookieWrites, [
					`NEXT_LOCALE=${desired}; Path=/; SameSite=Lax; Max-Age=31536000`,
				])
			}
		}
	}
})

test('native locale choice still navigates when preference cookies are rejected', () => {
	const browser = new OwnedBrowser({
		href: 'https://public.example/zh/models?q=test#pricing',
	})
	browser.document.writeBlocked = true
	const controls = mount(browser)
	install(browser)
	choose(browser, controls.locale, 'ko')
	assert.deepEqual(browser.navigations, ['/ko/models?q=test#pricing'])
	assert.equal(browser.document.cookieWrites.length, 1)
})

test('only marked native selects inside the current root accept valid preference values', () => {
	const browser = new OwnedBrowser()
	const controls = mount(browser)
	install(browser)
	const outside = new OwnedSelect('theme', 'dark')
	const unmarked = new OwnedSelect(null, 'dark')
	const unrelated = new OwnedSelect('workspace', 'dark')
	const nonSelect = new OwnedElement('theme', 'dark')
	for (const node of [unmarked, unrelated, nonSelect])
		controls.root.nodes.add(node)
	for (const target of [
		outside,
		unmarked,
		unrelated,
		nonSelect,
		null,
		{ value: 'dark' },
	])
		browser.document.dispatch('change', target)
	for (const value of ['', 'DARK', 'dark; injected=value', '../dark'])
		choose(browser, controls.theme, value)
	for (const value of [
		'',
		'fr',
		'EN',
		'../ko',
		'//outside.example',
		'ko?injected=value',
	])
		choose(browser, controls.locale, value)
	assert.equal(appearance(browser), 'light')
	assert.deepEqual(browser.document.cookieWrites, [])
	assert.deepEqual(browser.navigations, [])
	browser.document.root = new OwnedRoot()
	choose(browser, controls.theme, 'dark')
	assert.equal(appearance(browser), 'light')
	assert.deepEqual(browser.document.cookieWrites, [])
})

test('locale input cannot cross private, unsupported or malformed public path boundaries', () => {
	for (const pathname of [
		'/account',
		'/admin/models',
		'/api/public/catalog/models',
		'/fr/models',
		'/en/account',
		'/en/admin/models',
		'/en/models/a/b/c',
		'/en//models',
		'/en/models\\vendor\\slug',
		'/en/https://outside.example/models',
	]) {
		const browser = new OwnedBrowser()
		// Raw location shim preserves backslashes so the explicit boundary is exercised.
		browser.location.pathname = pathname
		const controls = mount(browser)
		install(browser)
		choose(browser, controls.locale, 'ja')
		assert.deepEqual(browser.document.cookieWrites, [], pathname)
		assert.deepEqual(browser.navigations, [], pathname)
	}
})

test('install and disposal are idempotent with one listener per surface and stale disposal cannot destroy reinstall', () => {
	const browser = new OwnedBrowser()
	const controls = mount(browser)
	const first = install(browser)
	assert.equal(install(browser), first)
	assert.equal(browser.document.listenerCount('change'), 1)
	assert.equal(browser.media.listenerCount('change'), 1)
	assert.equal(browser.listenerCount('pageshow'), 1)
	assert.equal(browser.mediaQueries.length, 1)
	choose(browser, controls.theme, 'dark')
	assert.equal(browser.document.cookieWrites.length, 1)
	first.dispose()
	first.dispose()
	assert.equal(browser.cinatokenPublicPreferences, undefined)
	assert.equal(browser.document.listenerCount('change'), 0)
	assert.equal(browser.media.listenerCount('change'), 0)
	assert.equal(browser.listenerCount('pageshow'), 0)
	choose(browser, controls.theme, 'light')
	assert.equal(browser.document.cookieWrites.length, 1)
	const second = install(browser)
	assert.notEqual(second, first)
	first.dispose()
	assert.equal(browser.cinatokenPublicPreferences, second)
	assert.equal(browser.document.listenerCount('change'), 1)
	assert.equal(browser.media.listenerCount('change'), 1)
	assert.equal(browser.listenerCount('pageshow'), 1)
	choose(browser, controls.theme, 'light')
	assert.equal(browser.document.cookieWrites.length, 2)
	second.dispose()
	assert.equal(browser.document.listenerCount('change'), 0)
	assert.equal(browser.media.listenerCount('change'), 0)
	assert.equal(browser.listenerCount('pageshow'), 0)
})
