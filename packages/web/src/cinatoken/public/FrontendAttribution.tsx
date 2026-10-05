/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import {
	FRONTEND_SOURCE_DOWNLOAD_URL,
	NEW_API_FRONTEND_ATTRIBUTION,
} from './frontend-attribution'
import { PUBLIC_FRONTEND_ORIGIN_URL } from './home/home-links'

export function FrontendAttribution(props: { originalProjectLabel?: string }) {
	const { t } = useTranslation()
	const localizedAttribution = t('cinatoken.home.attribution.statement')
	return (
		<>
			<span lang='en'>{NEW_API_FRONTEND_ATTRIBUTION}</span>{' '}
			{localizedAttribution !== NEW_API_FRONTEND_ATTRIBUTION ? (
				<>
					<span>{localizedAttribution}</span>{' '}
				</>
			) : null}
			<a
				href={PUBLIC_FRONTEND_ORIGIN_URL}
				target='_blank'
				rel='noopener noreferrer'
				className='underline underline-offset-2'
			>
				{props.originalProjectLabel ??
					t('cinatoken.home.attribution.originalProject')}
			</a>{' '}
			<a
				href={FRONTEND_SOURCE_DOWNLOAD_URL}
				className='underline underline-offset-2'
			>
				{t('cinatoken.home.attribution.sourceDownload')}
			</a>
		</>
	)
}
