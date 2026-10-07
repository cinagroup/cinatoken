/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { InitOptions, Services } from 'i18next'
import LanguageDetector, {
	type CustomDetector,
	type DetectorOptions,
} from 'i18next-browser-languagedetector'

/** Only language preferences use these optional storage boundaries. */
class PreferenceLanguageDetector extends LanguageDetector {
	override init(
		services?: Services,
		options?: DetectorOptions,
		i18nOptions?: InitOptions
	): void {
		super.init(services, options)
		this.i18nOptions = i18nOptions ?? {}
		const cookie = this.detectors.cookie as CustomDetector
		this.addDetector({
			name: 'cookie',
			lookup(options) {
				try {
					return cookie.lookup(options)
				} catch {
					return undefined
				}
			},
			cacheUserLanguage(language, options) {
				try {
					cookie.cacheUserLanguage?.(language, options)
				} catch {
					// The selected language remains available for this document.
				}
			},
		})
		this.addDetector({
			name: 'localStorage',
			lookup(options) {
				if (typeof window === 'undefined' || !options.lookupLocalStorage)
					return undefined
				try {
					return (
						window.localStorage.getItem(options.lookupLocalStorage) || undefined
					)
				} catch {
					return undefined
				}
			},
			cacheUserLanguage(language, options) {
				if (typeof window === 'undefined' || !options.lookupLocalStorage) return
				try {
					window.localStorage.setItem(options.lookupLocalStorage, language)
				} catch {
					// Availability can change after startup; keep the in-memory selection.
				}
			},
		})
	}
}

export function createPreferenceLanguageDetector(): LanguageDetector {
	return new PreferenceLanguageDetector()
}
