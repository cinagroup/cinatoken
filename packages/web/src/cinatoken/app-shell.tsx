/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme-provider'
import { Button } from '@/components/ui/button'
import { useCinaTokenSession } from './session-context'
import { SessionGate } from './session-gate'

const languages = [
	{ value: 'en', label: 'English' },
	{ value: 'zh', label: '简体中文' },
	{ value: 'ja', label: '日本語' },
	{ value: 'ko', label: '한국어' },
]

function SessionActions() {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	const returnPath = useRouterState({
		select: (state) => state.location.pathname + state.location.searchStr,
	})
	const isConsole = returnPath === '/admin' || returnPath.startsWith('/admin/')
	if (session.user)
		return (
			<div className='flex items-center gap-3'>
				<Link
					to='/account'
					className='text-muted-foreground hidden max-w-56 truncate text-sm sm:block'
				>
					{session.user.email}
				</Link>
				<Button
					variant='outline'
					disabled={session.isLoggingOut}
					onClick={() => void session.logout().catch(() => undefined)}
				>
					{t(
						session.isLoggingOut
							? 'cinatoken.shell.signingOut'
							: 'cinatoken.shell.signOut'
					)}
				</Button>
			</div>
		)
	return (
		<Button
			disabled={session.isLoginPending}
			onClick={() =>
				session.login({
					intent: isConsole ? 'admin' : 'portal',
					callbackPath: isConsole ? returnPath : '/account',
				})
			}
		>
			{t('cinatoken.shell.signIn')}
		</Button>
	)
}

export function ApplicationShell() {
	const { t, i18n } = useTranslation()
	const theme = useTheme()
	const session = useCinaTokenSession()
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
						href='/'
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
							href='/models'
							className='text-muted-foreground hover:text-foreground'
						>
							{t('cinatoken.shell.models')}
						</a>
						<Link
							to='/account'
							className='text-muted-foreground hover:text-foreground'
						>
							{t('cinatoken.shell.account')}
						</Link>
						{session.user?.capabilities.includes('admin.console') ? (
							<a
								href='/admin'
								className='text-muted-foreground hover:text-foreground'
							>
								{t('cinatoken.shell.admin')}
							</a>
						) : null}
					</nav>
					<div className='ml-auto flex flex-wrap items-center gap-2'>
						<label className='sr-only' htmlFor='language'>
							{t('cinatoken.shell.language')}
						</label>
						<select
							id='language'
							className='bg-background h-8 max-w-28 rounded-lg border px-2 text-sm'
							value={i18n.resolvedLanguage ?? 'en'}
							onChange={(event) => void i18n.changeLanguage(event.target.value)}
						>
							{languages.map((language) => (
								<option key={language.value} value={language.value}>
									{language.label}
								</option>
							))}
						</select>
						<label className='sr-only' htmlFor='theme'>
							{t('cinatoken.shell.theme')}
						</label>
						<select
							id='theme'
							className='bg-background h-8 rounded-lg border px-2 text-sm'
							value={theme.theme}
							onChange={(event) =>
								theme.setTheme(
									event.target.value as 'light' | 'dark' | 'system'
								)
							}
						>
							<option value='system'>{t('cinatoken.shell.systemTheme')}</option>
							<option value='light'>{t('cinatoken.shell.lightTheme')}</option>
							<option value='dark'>{t('cinatoken.shell.darkTheme')}</option>
						</select>
						<SessionActions />
					</div>
				</div>
			</header>
			{session.isLoginPending || session.error || session.loginError ? (
				<div className='mx-auto mt-4 flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 sm:px-6'>
					<p
						className='text-muted-foreground text-sm'
						role={session.error || session.loginError ? 'alert' : 'status'}
					>
						{session.error || session.loginError
							? t('cinatoken.shell.sessionError')
							: t('cinatoken.shell.loginPending')}
					</p>
					{session.isLoginPending ? (
						<div className='flex gap-2'>
							<Button variant='outline' onClick={session.refocusLogin}>
								{t('cinatoken.shell.refocus')}
							</Button>
							<Button variant='outline' onClick={session.cancelLogin}>
								{t('cinatoken.shell.cancel')}
							</Button>
						</div>
					) : (
						<Button
							variant='outline'
							disabled={session.isRefreshing}
							onClick={() => {
								session.cancelLogin()
								void session.refresh().catch(() => undefined)
							}}
						>
							{t('cinatoken.shell.retry')}
						</Button>
					)}
				</div>
			) : null}
			<main
				id='main-content'
				className='mx-auto min-h-[70vh] max-w-7xl px-4 py-8 sm:px-6'
			>
				<Outlet />
			</main>
			<footer className='text-muted-foreground border-t px-4 py-5 text-center text-xs leading-6'>
				<span>CinaToken · {t('cinatoken.shell.gateway')}</span>
				<br />
				<span>Frontend design and development by New API contributors. </span>
				<a
					href='https://github.com/QuantumNous/new-api'
					target='_blank'
					rel='noopener noreferrer'
					className='underline underline-offset-2'
				>
					New API
				</a>
			</footer>
		</div>
	)
}

function WorkspaceSelector() {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	const workspace = session.workspaceContext
	if (!workspace) return null
	return (
		<div className='bg-card mb-5 rounded-xl border p-4'>
			<label
				htmlFor='workspace'
				className='text-muted-foreground mb-2 block text-xs font-medium'
			>
				{t('cinatoken.shell.workspace')}
			</label>
			<select
				id='workspace'
				className='bg-background h-10 w-full rounded-lg border px-3 text-sm'
				disabled={session.isSwitchingWorkspace || session.isLoggingOut}
				value={workspace.currentWorkspace.id}
				onChange={(event) =>
					void session
						.switchWorkspace(event.target.value)
						.catch(() => undefined)
				}
			>
				{workspace.workspaces.map((item) => (
					<option key={item.id} value={item.id}>
						{item.name}
					</option>
				))}
			</select>
			<p className='text-muted-foreground mt-2 text-xs'>
				{t(`cinatoken.shell.${workspace.currentWorkspace.scopeType}`)}
			</p>
		</div>
	)
}

export function AccountLayout() {
	const { t } = useTranslation()
	return (
		<SessionGate>
			<div className='grid gap-8 md:grid-cols-[230px_minmax(0,1fr)]'>
				<aside>
					<WorkspaceSelector />
					<nav
						aria-label={t('cinatoken.shell.accountNavigation')}
						className='flex flex-wrap gap-1 text-sm md:grid'
					>
						<Link
							to='/account'
							activeOptions={{ exact: true }}
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							{t('cinatoken.shell.overview')}
						</Link>
						<Link
							to='/account/keys'
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							{t('cinatoken.shell.keys')}
						</Link>
						<Link
							to='/account/activity'
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							{t('cinatoken.shell.activity')}
						</Link>
						<Link
							to='/account/byok'
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							BYOK
						</Link>
						<Link
							to='/account/earnings'
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							{t('cinatoken.shell.earnings')}
						</Link>
						<Link
							to='/account/withdraw'
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							{t('cinatoken.shell.withdraw')}
						</Link>
						<Link
							to='/account/nft'
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							NFT
						</Link>
						<Link
							to='/account/presets'
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							{t('cinatoken.shell.presets')}
						</Link>
						<Link
							to='/account/guardrails'
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							{t('cinatoken.shell.guardrails')}
						</Link>
						<Link
							to='/account/settings'
							activeProps={{ className: 'bg-muted font-medium' }}
							className='rounded-lg px-3 py-2.5'
						>
							{t('cinatoken.shell.settings')}
						</Link>
					</nav>
				</aside>
				<div className='min-w-0'>
					<Outlet />
				</div>
			</div>
		</SessionGate>
	)
}

export function NotFoundPage() {
	const { t } = useTranslation()
	return (
		<div className='py-20 text-center'>
			<h1 className='text-3xl font-semibold'>404</h1>
			<p className='text-muted-foreground mt-3'>
				{t('cinatoken.shell.notFound')}
			</p>
			<Link to='/' className='mt-6 inline-block underline'>
				{t('cinatoken.shell.backHome')}
			</Link>
		</div>
	)
}
