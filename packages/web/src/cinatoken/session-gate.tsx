/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useCinaTokenSession } from './session-context'

export function SessionGate(props: { children: ReactNode }) {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	if (
		session.status === 'authenticated' &&
		session.user &&
		session.workspaceContext
	)
		return <>{props.children}</>
	if (session.status === 'loading' || session.isRefreshing)
		return (
			<p role='status' className='text-muted-foreground py-20 text-center'>
				{t('cinatoken.shell.restoringSession')}
			</p>
		)
	if (session.status === 'unavailable' || session.user)
		return (
			<Card className='mx-auto my-12 max-w-lg'>
				<CardHeader>
					<CardTitle>{t('cinatoken.shell.connectionUnavailable')}</CardTitle>
				</CardHeader>
				<CardContent>
					<p className='text-muted-foreground mb-5'>
						{t('cinatoken.shell.connectionHelp')}
					</p>
					<Button onClick={() => void session.refresh().catch(() => undefined)}>
						{t('cinatoken.shell.retry')}
					</Button>
				</CardContent>
			</Card>
		)
	return (
		<Card className='mx-auto my-12 max-w-lg'>
			<CardHeader>
				<CardTitle>{t('cinatoken.shell.signInTitle')}</CardTitle>
			</CardHeader>
			<CardContent>
				<p className='text-muted-foreground mb-5'>
					{t('cinatoken.shell.signInHelp')}
				</p>
				<div className='flex gap-3'>
					<Button
						disabled={session.isLoginPending}
						onClick={() =>
							session.login({ callbackPath: window.location.pathname })
						}
					>
						{t('cinatoken.shell.signIn')}
					</Button>
					<Button
						variant='outline'
						disabled={session.isLoginPending}
						onClick={() =>
							session.login({
								register: true,
								callbackPath: window.location.pathname,
							})
						}
					>
						{t('cinatoken.shell.register')}
					</Button>
				</div>
			</CardContent>
		</Card>
	)
}
