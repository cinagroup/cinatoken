/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { usePublicAuth } from './public-auth-context'

function safeErrorText(error: string | null, t: TFunction): string {
	switch (error) {
		case 'oidc_failed':
			return t('cinatoken.publicAuth.errors.oidcFailed')
		case 'admin_forbidden':
			return t('cinatoken.publicAuth.errors.adminForbidden')
		case 'popup_expired':
			return t('cinatoken.publicAuth.errors.popupExpired')
		case 'popup_blocked':
			return t('cinatoken.publicAuth.errors.popupBlocked')
		case 'runtime_unavailable':
			return t('cinatoken.publicAuth.errors.runtimeUnavailable')
		default:
			return t('cinatoken.publicAuth.errors.sessionUnavailable')
	}
}

export function PublicAuthStatusView(props: {
	auth: ReturnType<typeof usePublicAuth>
}) {
	const { t } = useTranslation()
	if (props.auth.phase === 'idle') return null
	let message: string
	switch (props.auth.phase) {
		case 'loading':
			message = t('cinatoken.publicAuth.loading')
			break
		case 'waiting':
			message = t('cinatoken.publicAuth.waiting')
			break
		case 'verifying':
			message = t('cinatoken.publicAuth.verifying')
			break
		case 'error':
			message = safeErrorText(props.auth.error, t)
			break
	}
	const isError = props.auth.phase === 'error'
	const buttonClass =
		'rounded-lg border px-3 py-2 text-sm font-medium focus-visible:outline-ring'
	return (
		<div
			role={isError ? 'alert' : 'status'}
			aria-live={isError ? 'assertive' : 'polite'}
			aria-busy={
				props.auth.phase === 'loading' || props.auth.phase === 'verifying'
			}
			data-public-auth-phase={props.auth.phase}
			className='mx-auto max-w-7xl px-4 pt-4 sm:px-6'
		>
			<div className='bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4'>
				<p className='min-w-0 flex-1 text-sm leading-6'>{message}</p>
				<div className='flex flex-wrap gap-2'>
					{props.auth.phase === 'waiting' && (
						<button
							type='button'
							className={buttonClass}
							onClick={props.auth.refocus}
						>
							{t('cinatoken.publicAuth.refocus')}
						</button>
					)}
					{isError && (
						<button
							type='button'
							className={buttonClass}
							onClick={props.auth.retry}
						>
							{t('cinatoken.publicAuth.retry')}
						</button>
					)}
					<button
						type='button'
						className={buttonClass}
						onClick={props.auth.cancel}
					>
						{t('cinatoken.publicAuth.cancel')}
					</button>
				</div>
			</div>
		</div>
	)
}

export function PublicAuthStatus() {
	const auth = usePublicAuth()
	return <PublicAuthStatusView auth={auth} />
}
