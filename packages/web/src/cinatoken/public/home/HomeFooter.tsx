/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { FrontendAttribution } from '../FrontendAttribution'
import { PUBLIC_DOCS_URL, PUBLIC_GITHUB_URL } from './home-links'

export function HomeFooter() {
	const { t } = useTranslation()
	return (
		<footer className='text-muted-foreground mt-16 space-y-5 border-t pt-8 text-sm'>
			<div className='flex flex-wrap items-start justify-between gap-5'>
				<div className='space-y-2'>
					<p className='text-foreground font-semibold'>CinaToken</p>
					<p>{t('cinatoken.home.footer.description')}</p>
				</div>
				<nav aria-label={t('cinatoken.home.nav.label')} className='flex gap-5'>
					<a
						href={PUBLIC_GITHUB_URL}
						target='_blank'
						rel='noopener noreferrer'
						className='underline underline-offset-4'
					>
						GitHub
					</a>
					<a
						href={PUBLIC_DOCS_URL}
						target='_blank'
						rel='noopener noreferrer'
						className='underline underline-offset-4'
					>
						{t('cinatoken.home.nav.docs')}
					</a>
				</nav>
				<p>© 2026 CinaGroup</p>
			</div>
			<p className='border-t pt-5 text-xs leading-5'>
				<FrontendAttribution />
			</p>
		</footer>
	)
}
