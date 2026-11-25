/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import {
	FRONTEND_NOTICE_URL,
	FRONTEND_SOURCE_DOWNLOAD_URL,
} from './frontend-attribution'

export function FrontendLinks() {
	const { t } = useTranslation()
	return (
		<span className='inline-flex flex-wrap gap-x-5 gap-y-2'>
			<a
				href={FRONTEND_SOURCE_DOWNLOAD_URL}
				className='hover:text-foreground focus-visible:outline-ring rounded-sm underline underline-offset-4'
			>
				{t('cinatoken.home.footer.sourceDownload')}
			</a>
			<a
				href={FRONTEND_NOTICE_URL}
				className='hover:text-foreground focus-visible:outline-ring rounded-sm underline underline-offset-4'
			>
				{t('cinatoken.home.footer.license')}
			</a>
		</span>
	)
}
