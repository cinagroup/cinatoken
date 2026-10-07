/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import {
	Link,
	useRouter,
	type ErrorComponentProps,
} from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { retryFailedRoute } from './route-recovery'

export function RoutePendingComponent() {
	const { t } = useTranslation()
	return (
		<section
			role='status'
			aria-live='polite'
			aria-busy='true'
			className='py-20 text-center'
		>
			<p className='text-muted-foreground'>
				{t('cinatoken.shell.loadingPage')}
			</p>
		</section>
	)
}

export function RouteErrorComponent(props: ErrorComponentProps) {
	const { t } = useTranslation()
	const router = useRouter()
	const mounted = useRef(false)
	const pending = useRef(false)
	const [retrying, setRetrying] = useState(false)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	async function retry(): Promise<void> {
		if (pending.current) return
		pending.current = true
		setRetrying(true)
		try {
			await retryFailedRoute(router, () => {
				if (mounted.current) props.reset()
			})
		} catch {
			// Keep the safe error state available if loading fails again.
		} finally {
			pending.current = false
			if (mounted.current) setRetrying(false)
		}
	}
	return (
		<section className='py-20 text-center'>
			<div role='alert'>
				<h1 className='text-3xl font-semibold'>
					{t('cinatoken.shell.pageUnavailable')}
				</h1>
				<p className='text-muted-foreground mt-3'>
					{t('cinatoken.shell.pageUnavailableHelp')}
				</p>
			</div>
			<div className='mt-6 flex flex-wrap justify-center gap-4'>
				<button
					type='button'
					onClick={() => void retry()}
					disabled={retrying}
					aria-busy={retrying}
					className='bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm disabled:opacity-50'
				>
					{t(
						retrying ? 'cinatoken.shell.retryingPage' : 'cinatoken.shell.retry'
					)}
				</button>
				<Link to='/' className='inline-block self-center underline'>
					{t('cinatoken.shell.backHome')}
				</Link>
			</div>
		</section>
	)
}
