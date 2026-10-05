/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useSyncExternalStore } from 'react'
import { Outlet, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { LoginOptions } from '../../auth-popup-contract'
import { FrontendAttribution } from '../FrontendAttribution'
import { PublicAuthAccessLink } from '../auth/PublicAuthAccessLink'
import { PublicAuthStatus } from '../auth/PublicAuthStatus'
import {
	PUBLIC_LOCALES,
	isPublicLocale,
	localizePublicHref,
	usePublicLocation,
} from './public-location'

const themeEvent = 'cinatoken:public-theme'
type PublicTheme = 'system' | 'light' | 'dark'
function storedTheme(): PublicTheme {
	try {
		const value = document.cookie
			.split(';')
			.map((part) => part.trim())
			.find((part) => part.startsWith('cinatoken-theme='))
			?.slice('cinatoken-theme='.length)
		return value === 'light' || value === 'dark' ? value : 'system'
	} catch {
		return 'system'
	}
}
function systemTheme(): 'light' | 'dark' {
	return window.matchMedia('(prefers-color-scheme: dark)').matches
		? 'dark'
		: 'light'
}
function subscribeTheme(listener: () => void): () => void {
	const media = window.matchMedia('(prefers-color-scheme: dark)')
	media.addEventListener('change', listener)
	window.addEventListener(themeEvent, listener)
	return () => {
		media.removeEventListener('change', listener)
		window.removeEventListener(themeEvent, listener)
	}
}
function PublicThemeControl() {
	const { t } = useTranslation()
	const theme = useSyncExternalStore(
		subscribeTheme,
		storedTheme,
		() => 'system' as const
	)
	const system = useSyncExternalStore(
		subscribeTheme,
		systemTheme,
		() => 'light' as const
	)
	useEffect(() => {
		document.documentElement.classList.remove('light', 'dark')
		document.documentElement.classList.add(theme === 'system' ? system : theme)
	}, [theme, system])
	return (
		<label className='text-sm'>
			<span className='sr-only'>{t('cinatoken.shell.theme')}</span>
			<select
				className='bg-background h-8 rounded-lg border px-2 text-sm'
				value={theme}
				onChange={(event) => {
					const value = event.target.value
					if (value !== 'system' && value !== 'light' && value !== 'dark')
						return
					document.cookie = `cinatoken-theme=${value}; Path=/; SameSite=Lax; Max-Age=31536000`
					window.dispatchEvent(new Event(themeEvent))
				}}
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
								value={location.locale}
								onChange={(event) => {
									const locale = event.target.value
									if (!isPublicLocale(locale)) return
									document.cookie = `NEXT_LOCALE=${locale}; Path=/; SameSite=Lax; Max-Age=31536000`
									window.location.assign(
										localizePublicHref(
											window.location.pathname +
												window.location.search +
												window.location.hash,
											locale
										)
									)
								}}
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
