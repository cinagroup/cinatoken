/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { formatUserDetailTime } from '../user-detail/user-detail-format'

export function GatewayKeyLastUsed(props: {
	value: string | null | undefined
	timezone: string | null
}) {
	const { t, i18n } = useTranslation()
	if (props.value === undefined)
		return <span>{t('cinatoken.adminGatewayKeys.lastUsedUnavailable')}</span>
	if (props.value === null)
		return <span>{t('cinatoken.adminGatewayKeys.noUsageRecorded')}</span>
	return (
		<span>
			{formatUserDetailTime(
				props.value,
				i18n.resolvedLanguage ?? 'en',
				props.timezone
			)}
		</span>
	)
}
