/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useCinaTokenSession } from '../session-context'
import { useCinaTokenConsole } from './console-context'

export function ConsoleGate(props: { children: ReactNode }) {
	const { t } = useTranslation()
	const portal = useCinaTokenSession()
	const console = useCinaTokenConsole()
	const prefix = 'cinatoken.console.'
	if (
		portal.status === 'loading' ||
		portal.isRefreshing ||
		portal.isLoggingOut ||
		portal.isSwitchingWorkspace
	)
		return (
			<p role='status' className='text-muted-foreground py-20 text-center'>
				{t(prefix + 'checking')}
			</p>
		)
	if (console.isVerified) return <>{props.children}</>
	if (portal.user && console.status === 'checking')
		return (
			<p role='status' className='text-muted-foreground py-20 text-center'>
				{t(prefix + 'checking')}
			</p>
		)
	const needsLogin = portal.status === 'unauthenticated' && !portal.user
	const unavailable =
		(portal.status === 'unavailable' && !portal.user) ||
		console.status === 'degraded'
	let title = 'forbiddenTitle'
	let help = 'forbiddenHelp'
	if (needsLogin) {
		title = 'signInTitle'
		help = 'signInHelp'
	} else if (unavailable) {
		title = 'unavailableTitle'
		help = 'unavailableHelp'
	}
	return (
		<section
			className='bg-card mx-auto my-12 max-w-lg space-y-5 rounded-xl border p-6'
			aria-labelledby='console-access-title'
		>
			<h1 id='console-access-title' className='text-2xl font-semibold'>
				{t(prefix + title)}
			</h1>
			<p
				className='text-muted-foreground text-sm'
				role={needsLogin ? undefined : 'alert'}
			>
				{t(prefix + help)}
			</p>
			<div className='flex flex-wrap gap-3'>
				{needsLogin ? (
					<Button
						disabled={portal.isLoginPending}
						onClick={() =>
							portal.login({
								intent: 'admin',
								callbackPath: window.location.pathname + window.location.search,
							})
						}
					>
						{t(prefix + 'signIn')}
					</Button>
				) : (
					<Button
						disabled={console.isRefreshing}
						onClick={() => void console.revalidate().catch(() => undefined)}
					>
						{t(prefix + 'retry')}
					</Button>
				)}
				<Link
					to='/account'
					className='inline-flex items-center rounded-lg border px-3 py-2 text-sm'
				>
					{t(prefix + 'account')}
				</Link>
			</div>
		</section>
	)
}
