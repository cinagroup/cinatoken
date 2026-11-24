/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { UserDisplay } from './users-display'

export function AdminListTimezone(props: { display: UserDisplay | null }) {
	const { t } = useTranslation()
	let key = 'timezoneUnavailable'
	if (props.display?.timezone) {
		key = 'timezoneConfigured'
		if (props.display.timezoneSource === 'legacy') key = 'timezoneLegacy'
		if (
			props.display.timezoneSource === 'missing' ||
			props.display.timezoneSource === 'invalid'
		)
			key = 'timezoneFallback'
	}
	return (
		<p role='status' className='text-muted-foreground text-sm break-words'>
			{t('cinatoken.adminUsers.' + key, {
				timezone: props.display?.timezone ?? 'UTC',
			})}
		</p>
	)
}
