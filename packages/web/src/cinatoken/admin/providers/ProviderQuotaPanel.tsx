/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '../../../components/ui/alert'
import { Button } from '../../../components/ui/button'
import type { ProvidersApi, ProviderRequestOptions } from '../provider-api'
import type { ProviderQuota } from './provider-compatibility'
import { providerErrorKey, providerAccessDenied } from './provider-errors'
import { formatProviderQuotaNumber } from './provider-quota-format'

const prefix = 'cinatoken.adminProviders.'
export function ProviderQuotaPanel(props: {
	api: ProvidersApi
	id: string
	disabled: boolean
	onFailure?: (error: unknown) => void
	readOptions?: (signal?: AbortSignal) => ProviderRequestOptions
}) {
	const { t, i18n } = useTranslation(),
		controller = useRef<AbortController | null>(null)
	const [data, setData] = useState<ProviderQuota | null>(null),
		[error, setError] = useState<unknown>(null),
		[busy, setBusy] = useState(false)
	useEffect(() => () => controller.current?.abort(), [])
	async function query() {
		if (props.disabled || busy) return
		controller.current?.abort()
		const request = new AbortController()
		controller.current = request
		setError(null)
		setData(null)
		setBusy(true)
		try {
			const next = await props.api.providerQuota(
				props.id,
				props.readOptions?.(request.signal) ?? { signal: request.signal }
			)
			if (!request.signal.aborted) setData(next)
		} catch (e) {
			if (!request.signal.aborted) {
				setError(e)
				if (providerAccessDenied(e)) props.onFailure?.(e)
			}
		} finally {
			if (!request.signal.aborted) setBusy(false)
		}
	}
	const number = (value: number | undefined) =>
		formatProviderQuotaNumber(value, i18n.resolvedLanguage)
	const date = (value: string | null | undefined) =>
		value ? new Date(value).toLocaleString(i18n.resolvedLanguage) : '—'
	return (
		<section
			aria-label={t(prefix + 'quota')}
			className='flex min-w-0 flex-col gap-3 rounded-lg border p-4'
		>
			<h3 className='font-medium'>{t(prefix + 'quota')}</h3>
			<p className='text-muted-foreground text-xs'>{t(prefix + 'quotaHint')}</p>
			<Button
				type='button'
				variant='outline'
				disabled={props.disabled || busy}
				onClick={() => void query()}
			>
				{t(prefix + (busy ? 'loading' : 'quotaQuery'))}
			</Button>
			{error != null && (
				<Alert>
					<AlertDescription>{t(providerErrorKey(error))}</AlertDescription>
				</Alert>
			)}
			{data && (
				<>
					<p role='status'>
						{t(prefix + 'quotaState_' + data.state)} ·{' '}
						{t(prefix + 'quotaChecked')}: {date(data.checkedAt)}
					</p>
					<dl className='flex flex-col gap-2'>
						{data.balances.map((balance, index) => (
							<div key={index} className='flex flex-col gap-1 text-sm'>
								<dt>
									{t(prefix + 'quotaBalance')} ({balance.currency})
								</dt>
								<dd className='font-medium tabular-nums'>
									{number(balance.total)}
								</dd>
								<dd className='text-muted-foreground text-xs'>
									{t(prefix + 'quotaGranted')}: {number(balance.granted)} ·{' '}
									{t(prefix + 'quotaPaid')}: {number(balance.paid)}
								</dd>
							</div>
						))}
					</dl>
					{data.windows.length > 0 && (
						<div className='min-w-0 overflow-x-auto'>
							<table className='w-full text-left text-xs'>
								<thead>
									<tr>
										{[
											'quotaWindow',
											'quotaUnit',
											'quotaUsed',
											'quotaLimit',
											'quotaRemaining',
											'quotaUsed',
											'quotaReset',
										].map((key, index) => (
											<th key={index} className='p-2'>
												{t(prefix + key)}
												{index === 5 ? ' %' : ''}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{data.windows.map((window) => (
										<tr key={window.id}>
											<th className='p-2'>{window.id}</th>
											<td className='p-2'>{window.unit}</td>
											<td className='p-2'>{number(window.used)}</td>
											<td className='p-2'>{number(window.limit)}</td>
											<td className='p-2'>{number(window.remaining)}</td>
											<td className='p-2'>{number(window.usedPercent)}</td>
											<td className='p-2'>{date(window.resetsAt)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</>
			)}
		</section>
	)
}
