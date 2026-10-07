/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { i18n } from 'i18next'
import { getCookie } from '@/lib/cookies'

type PreferenceBrowser = Pick<
	Window,
	'addEventListener' | 'removeEventListener' | 'location'
>

function readLanguageCookie(): string | null | undefined {
	try {
		return getCookie('NEXT_LOCALE') ?? null
	} catch {
		return undefined
	}
}

/** The private entry has no URL locale; public documents keep their URL authority. */
export function installPrivateLanguageRestoration(
	instance: i18n,
	browser: PreferenceBrowser = window
): () => void {
	let storedCookie = readLanguageCookie()
	const rememberSelection = () => {
		const current = readLanguageCookie()
		if (current !== undefined) storedCookie = current
	}
	const restore = () => {
		if (/^\/(?:en|zh|ja|ko)(?:\/|$)/.test(browser.location.pathname)) return
		const current = readLanguageCookie()
		if (current === undefined) return
		const changed = storedCookie !== undefined && current !== storedCookie
		storedCookie = current
		// The first readable cookie after denied reads is only a baseline.
		if (!changed) return
		// Reuse the private detector's cookie → optional storage → navigator order.
		void instance.changeLanguage()
	}
	instance.on('languageChanged', rememberSelection)
	browser.addEventListener('pageshow', restore)
	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		instance.off('languageChanged', rememberSelection)
		browser.removeEventListener('pageshow', restore)
	}
}
