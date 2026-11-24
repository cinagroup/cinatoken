/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { formatUserDetailTime } from '../user-detail/user-detail-format'

export function AccessKeyLastUsed(props: {
	value: string | null
	timezone: string | null
}) {
	const { t, i18n } = useTranslation()
	const value =
		props.value === null
			? t('cinatoken.adminAccessKeys.never')
			: formatUserDetailTime(
					props.value,
					i18n.resolvedLanguage ?? 'en',
					props.timezone
				)
	return (
		<p className='text-muted-foreground text-xs break-words'>
			{t('cinatoken.adminAccessKeys.lastUsed')}: {value}
		</p>
	)
}
