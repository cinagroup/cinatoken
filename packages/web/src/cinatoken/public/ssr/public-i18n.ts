/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createInstance, type i18n } from 'i18next'
import { chatMessages } from '../../chat/messages'
import { shellMessages } from '../../shell-messages'
import { publicAuthMessages } from '../auth/messages'
import { publicHomeMessages } from '../home/home-messages'
import { publicMessages } from '../messages'
import { PUBLIC_LOCALES, type PublicLocale } from './public-location'

/** Provider-local instances avoid the global react-i18next registration and browser detector. */
export function createPublicI18n(locale: PublicLocale): i18n {
	const instance = createInstance()
	void instance.init({
		lng: locale,
		fallbackLng: 'en',
		supportedLngs: [...PUBLIC_LOCALES],
		load: 'languageOnly',
		initAsync: false,
		interpolation: { escapeValue: false },
		resources: Object.fromEntries(
			PUBLIC_LOCALES.map((language) => [
				language,
				{
					translation: {
						cinatoken: {
							shell: shellMessages[language],
							public: publicMessages[language],
							publicAuth: publicAuthMessages[language],
							chat: chatMessages[language],
							home: publicHomeMessages[language],
						},
					},
				},
			])
		),
	})
	if (!instance.isInitialized)
		throw new Error('Public translations did not initialize synchronously')
	return instance
}
