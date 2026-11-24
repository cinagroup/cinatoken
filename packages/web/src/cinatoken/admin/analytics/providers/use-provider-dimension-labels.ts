/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderDimensionLabels } from './provider-dimensions'

const prefix = 'cinatoken.adminModelAnalytics.'
export function useProviderDimensionLabels(): ProviderDimensionLabels {
	const { t } = useTranslation()
	return useMemo(
		() => ({
			unclassified: t(prefix + 'kindUnclassified'),
			custom: t(prefix + 'kindCustom'),
			unknown: t(prefix + 'kindUnknown'),
			unavailable: t(prefix + 'kindUnavailable'),
			rest: t(prefix + 'kindRest'),
			mcp: t(prefix + 'kindMcp'),
		}),
		[t]
	)
}
