/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { BrandIdentity } from '../../brand-logo'
import { FrontendLinks } from '../FrontendLinks'
import { usePublicLocation } from '../ssr/public-location'
import { publicDocsHref, PUBLIC_GITHUB_URL } from './home-links'

export function HomeFooter() {
	const { t } = useTranslation()
	const { locale } = usePublicLocation()
	return (
		<footer className='text-muted-foreground flex flex-wrap items-start justify-between gap-6 border-t pt-6 text-xs leading-6'>
			<div className='flex flex-wrap items-baseline gap-x-4 gap-y-1'>
				<BrandIdentity className='size-7 shrink-0' />
				<p>{t('cinatoken.home.footer.description')}</p>
			</div>
			<div className='space-y-3 sm:text-right'>
				<nav
					aria-label={t('cinatoken.home.footer.navigation')}
					className='flex flex-wrap gap-x-5 gap-y-2'
				>
					<a
						href={PUBLIC_GITHUB_URL}
						target='_blank'
						rel='noopener noreferrer'
						className='hover:text-foreground focus-visible:outline-ring rounded-sm underline underline-offset-4'
					>
						GitHub
					</a>
					<a
						href={publicDocsHref(locale)}
						className='hover:text-foreground focus-visible:outline-ring rounded-sm underline underline-offset-4'
					>
						{t('cinatoken.home.nav.docs')}
					</a>
					<FrontendLinks />
				</nav>
				<p>© 2026 CinaGroup</p>
			</div>
		</footer>
	)
}
