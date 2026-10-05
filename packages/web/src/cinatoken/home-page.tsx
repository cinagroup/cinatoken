/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
	callbackPath: '/dashboard',
}

export function HomePage() {
	const { t } = useTranslation()
	const { href } = usePublicLocation()
	return (
		<div className='py-10 sm:py-20'>
			<p className='text-muted-foreground mb-5 text-sm font-medium tracking-widest uppercase'>
				CinaToken Gateway
			</p>
			<h1 className='max-w-3xl text-4xl leading-tight font-semibold tracking-tight sm:text-6xl'>
				{t('cinatoken.shell.homeTitle')}
			</h1>
			<p className='text-muted-foreground mt-6 max-w-2xl text-lg leading-8'>
				{t('cinatoken.shell.homeDescription')}
			</p>
			<div className='mt-8 flex flex-wrap gap-3'>
				<PublicAuthAccessLink
					options={accountAccess}
					href='/account'
					className='bg-primary text-primary-foreground rounded-lg px-5 py-3 text-sm font-medium'
				>
					{t('cinatoken.shell.openAccount')}
				</PublicAuthAccessLink>
				<a
					href={href('/models')}
					className='rounded-lg border px-5 py-3 text-sm font-medium'
				>
					{t('cinatoken.shell.browseModels')}
				</a>
				<PublicAuthAccessLink
					options={consoleAccess}
					href='/dashboard'
					className='rounded-lg border px-5 py-3 text-sm font-medium'
				>
					{t('cinatoken.home.hero.console')}
				</PublicAuthAccessLink>
				<a
					href={PUBLIC_DOCS_URL}
					target='_blank'
					rel='noopener noreferrer'
					className='rounded-lg border px-5 py-3 text-sm font-medium'
				>
					{t('cinatoken.home.hero.docs')}
				</a>
			</div>
			<nav
				aria-label={t('cinatoken.public.publicNavigation')}
				className='mt-8 flex flex-wrap gap-x-5 gap-y-3 text-sm'
			>
				{publicDestinations.map(([path, title]) => (
					<a
						key={path}
						href={href(path)}
						className='text-muted-foreground hover:text-foreground focus-visible:outline-ring rounded-sm underline-offset-4 hover:underline'
					>
						{t(`cinatoken.public.${title}`)}
					</a>
				))}
				<a
					href={href('/chat')}
					className='text-muted-foreground hover:text-foreground focus-visible:outline-ring rounded-sm underline-offset-4 hover:underline'
				>
					{t('cinatoken.chat.title')}
				</a>
			</nav>
			<nav
				aria-label={t('cinatoken.home.nav.label')}
				className='text-muted-foreground mt-5 flex flex-wrap gap-5 text-sm'
			>
				{(['features', 'architecture', 'deployment'] as const).map(
					(section) => (
						<a
							key={section}
							href={`#${section}`}
							className='underline underline-offset-4'
						>
							{t(`cinatoken.home.nav.${section}`)}
						</a>
					)
				)}
			</nav>
			<HomeGatewayDemo />
			<div className='mt-16 grid gap-5 md:grid-cols-3'>
				{['resources', 'governance', 'visibility'].map((feature) => (
					<Card key={feature}>
						<CardHeader>
							<CardTitle>{t(`cinatoken.shell.${feature}Title`)}</CardTitle>
						</CardHeader>
						<CardContent className='text-muted-foreground leading-7'>
							{t(`cinatoken.shell.${feature}Description`)}
						</CardContent>
					</Card>
				))}
			</div>
			<HomeProductSections />
			<HomeFooter />
		</div>
	)
}
