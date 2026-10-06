/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect } from 'react'
import { Outlet, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { LoginOptions } from '../../auth-popup-contract'
import { FrontendAttribution } from '../FrontendAttribution'
import { PublicAuthAccessLink } from '../auth/PublicAuthAccessLink'
import { PublicAuthStatus } from '../auth/PublicAuthStatus'
import { PUBLIC_LOCALES, usePublicLocation } from './public-location'

function PublicThemeControl() {
	const { t } = useTranslation()
	return (
		<label className='text-sm'>
			<span className='sr-only'>{t('cinatoken.shell.theme')}</span>
			<select
				className='bg-background h-8 rounded-lg border px-2 text-sm'
				data-cinatoken-public-preference='theme'
				defaultValue='system'
			>
				<option value='system'>{t('cinatoken.shell.systemTheme')}</option>
				<option value='light'>{t('cinatoken.shell.lightTheme')}</option>
				<option value='dark'>{t('cinatoken.shell.darkTheme')}</option>
			</select>
		</label>
	)
}

const names = { en: 'English', zh: '简体中文', ja: '日本語', ko: '한국어' }
const accountAccess: LoginOptions = {
	intent: 'portal',
	callbackPath: '/account',
}
export function PublicShell() {
	const { t } = useTranslation()
	const location = usePublicLocation()
	useEffect(() => {
		const preferences = window.cinatokenPublicPreferences
		if (!preferences) return
		preferences.syncControls()
		document.documentElement.dataset.cinatokenPublicHydration = 'ready'
		return () => {
			delete document.documentElement.dataset.cinatokenPublicHydration
		}
	}, [])
	const isHome = useRouterState({
		select: (state) =>
			state.matches.some(
				(match) => match.routeId === '/' && match.status === 'success'
			),
	})
	return (
		<div className='min-h-svh'>
			<a
				href='#main-content'
				className='bg-primary text-primary-foreground sr-only rounded-md px-4 py-2 focus:not-sr-only focus:fixed focus:z-50'
			>
				{t('cinatoken.shell.skipToContent')}
			</a>
			<header className='bg-background/95 border-b'>
				<div className='mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-4 sm:px-6'>
					<a
						href={location.href('/')}
						className='flex items-center gap-2 font-semibold tracking-tight'
					>
						<span className='bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg'>
							C
						</span>
						CinaToken
					</a>
					<nav
						aria-label={t('cinatoken.shell.primaryNavigation')}
						className='flex items-center gap-4 text-sm'
					>
						<a
							href={location.href('/models')}
							className='text-muted-foreground hover:text-foreground'
						>
							{t('cinatoken.shell.models')}
						</a>
						<PublicAuthAccessLink
							options={accountAccess}
							href='/account'
							className='text-muted-foreground hover:text-foreground'
						>
							{t('cinatoken.shell.account')}
						</PublicAuthAccessLink>
					</nav>
					<div className='ml-auto flex flex-wrap items-center gap-2'>
						<label className='text-sm'>
							<span className='sr-only'>{t('cinatoken.shell.language')}</span>
							<select
								className='bg-background h-8 max-w-28 rounded-lg border px-2 text-sm'
								data-cinatoken-public-preference='locale'
								defaultValue={location.locale}
							>
								{PUBLIC_LOCALES.map((locale) => (
									<option key={locale} value={locale}>
										{names[locale]}
									</option>
								))}
							</select>
						</label>
						<PublicThemeControl />
						<PublicAuthAccessLink
							options={accountAccess}
							className='bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm'
						>
							{t('cinatoken.shell.signIn')}
						</PublicAuthAccessLink>
					</div>
				</div>
			</header>
			<PublicAuthStatus />
			<main
				id='main-content'
				className='mx-auto min-h-[70vh] max-w-7xl px-4 py-8 sm:px-6'
			>
				<Outlet />
			</main>
			{!isHome && (
				<footer className='text-muted-foreground border-t px-4 py-5 text-center text-xs leading-6'>
					<span>CinaToken · {t('cinatoken.shell.gateway')}</span>
					<br />
					<FrontendAttribution originalProjectLabel='New API' />
				</footer>
			)}
		</div>
	)
}

export function PublicNotFoundPage() {
	const { t } = useTranslation()
	const location = usePublicLocation()
	return (
		<section className='py-20 text-center'>
			<h1 className='text-3xl font-semibold'>404</h1>
			<p className='text-muted-foreground mt-3'>
				{t('cinatoken.shell.notFound')}
			</p>
			<a href={location.href('/')} className='mt-6 inline-block underline'>
				{t('cinatoken.shell.backHome')}
			</a>
		</section>
	)
}
