/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { LoginOptions } from './auth-popup-contract'
import { PublicAuthAccessLink } from './public/auth/PublicAuthAccessLink'
import { HomeFooter } from './public/home/HomeFooter'
import { HomeGatewayDemo } from './public/home/HomeGatewayDemo'
import { HomeProductSections } from './public/home/HomeProductSections'
import { PUBLIC_DOCS_URL } from './public/home/home-links'
import { usePublicLocation } from './public/ssr/public-location'

const publicDestinations = [
	['/models', 'modelsTitle'],
	['/providers', 'providersTitle'],
	['/compare', 'compareTitle'],
	['/rankings', 'rankingsTitle'],
	['/benchmarks', 'benchmarksTitle'],
] as const
const accountAccess: LoginOptions = {
	intent: 'portal',
	callbackPath: '/account',
}
const consoleAccess: LoginOptions = {
	intent: 'admin',
	callbackPath: '/admin',
}

export function HomePage() {
	const { t } = useTranslation()
	const { href } = usePublicLocation()
	return (
		<div className='mx-auto max-w-6xl pt-6 pb-2 sm:pt-10'>
			<section className='grid items-start gap-10 pb-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-14 lg:pb-16'>
				<div className='min-w-0 lg:pt-6'>
					<h1 className='max-w-xs text-4xl leading-[1.25] font-semibold tracking-tight text-balance sm:max-w-sm sm:text-[2.75rem] [&:lang(ko)]:break-keep'>
						{t('cinatoken.shell.homeTitle')}
					</h1>
					<p className='text-muted-foreground mt-5 max-w-md text-base leading-7'>
						{t('cinatoken.shell.homeDescription')}
					</p>
					<div className='mt-7 flex flex-wrap gap-3'>
						<a
							href={href('/models')}
							className='bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-ring rounded-[6px] px-5 py-3 text-sm font-medium'
						>
							{t('cinatoken.shell.browseModels')}
						</a>
						<PublicAuthAccessLink
							options={accountAccess}
							href='/account'
							className='hover:bg-muted focus-visible:outline-ring rounded-[6px] border px-5 py-3 text-sm font-medium'
						>
							{t('cinatoken.shell.account')}
						</PublicAuthAccessLink>
					</div>
					<div className='text-muted-foreground mt-6 flex flex-wrap gap-6 text-sm'>
						<PublicAuthAccessLink
							options={consoleAccess}
							href='/admin'
							className='hover:text-foreground focus-visible:outline-ring rounded-sm underline underline-offset-4'
						>
							{t('cinatoken.home.hero.console')}
						</PublicAuthAccessLink>
						<a
							href={PUBLIC_DOCS_URL}
							target='_blank'
							rel='noopener noreferrer'
							className='hover:text-foreground focus-visible:outline-ring rounded-sm underline underline-offset-4'
						>
							{t('cinatoken.home.hero.docs')}
						</a>
					</div>
				</div>
				<HomeGatewayDemo />
			</section>
			<nav
				aria-label={t('cinatoken.public.publicNavigation')}
				className='text-muted-foreground flex flex-wrap items-center gap-x-6 gap-y-4 border-y py-5 text-sm sm:justify-between'
			>
				{publicDestinations.map(([path, title]) => (
					<a
						key={path}
						href={href(path)}
						className='hover:text-foreground focus-visible:outline-ring rounded-sm underline-offset-4 hover:underline'
					>
						{t(`cinatoken.public.${title}`)}
					</a>
				))}
				<a
					href={href('/chat')}
					className='hover:text-foreground focus-visible:outline-ring rounded-sm underline-offset-4 hover:underline'
				>
					{t('cinatoken.chat.title')}
				</a>
			</nav>
			<HomeProductSections />
			<HomeFooter />
		</div>
	)
}
