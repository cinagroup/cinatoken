/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect } from 'react'
import i18n from './i18n'
import { installPrivateLanguageRestoration } from './private-language-restoration'

export function PrivateLanguageRestoration() {
	useEffect(() => installPrivateLanguageRestoration(i18n), [])
	return null
}
