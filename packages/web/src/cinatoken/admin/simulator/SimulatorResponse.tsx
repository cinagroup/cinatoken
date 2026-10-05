/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { simulatorResponseView, snapshotLogsHref } from './simulator-response'
import { codeBlockClass, panelClass } from './simulator-utils'
import type { SimulatorResponse as ResponseValue } from './use-simulator'

function SimulatorAudio(props: { blob: Blob }) {
	const { t } = useTranslation()
	const audio = useRef<HTMLAudioElement>(null)
	const download = useRef<HTMLAnchorElement>(null)
	useEffect(() => {
		const next = URL.createObjectURL(props.blob)
		const element = audio.current
		const link = download.current
		if (element) element.src = next
		if (link) link.href = next
		return () => {
			if (element) {
				element.pause()
				element.removeAttribute('src')
				element.load()
			}
			if (link) link.removeAttribute('href')
			URL.revokeObjectURL(next)
		}
	}, [props.blob])
	return (
		<div className='space-y-3 rounded-md border p-4'>
			<h3 className='text-sm font-medium'>
				{t('cinatoken.adminSimulator.audioPreview')}
			</h3>
			<p className='text-muted-foreground text-xs'>
				{t('cinatoken.adminSimulator.audioResponseReceived', {
					bytes: props.blob.size,
				})}
			</p>
			<audio ref={audio} className='w-full' controls />
			<a
				ref={download}
				className='text-primary text-sm underline'
				download='speech-output'
			>
				{t('cinatoken.adminSimulator.downloadAudio')}
			</a>
		</div>
	)
}
export function SimulatorResponse(props: {
	response: ResponseValue | null
	canReadLogs: boolean
}) {
	const { t } = useTranslation()
	const [tab, setTab] = useState<'merged' | 'raw'>('merged')
	const scroll = useRef<HTMLPreElement>(null)
	const response = props.response
	const view = useMemo(
		() => (response ? simulatorResponseView(response) : null),
		[response]
	)
	useEffect(() => {
		if (scroll.current && response?.meta.outcome === 'running')
			scroll.current.scrollTop = scroll.current.scrollHeight
	}, [response?.raw, response?.meta.outcome, tab])
	return (
		<section
			className={panelClass + ' h-full'}
			aria-labelledby='simulator-response'
		>
			<div className='flex flex-wrap items-center justify-between gap-2'>
				<h2 id='simulator-response' className='font-semibold'>
					{t('cinatoken.adminSimulator.response')}
				</h2>
				{response && (
					<div className='flex flex-wrap gap-2 text-xs'>
						{response.meta.status !== null && (
							<span className='bg-muted rounded-full px-2 py-1'>
								HTTP {response.meta.status}
							</span>
						)}
						{response.meta.latencyMs !== null && (
							<span
								title={t('cinatoken.adminSimulator.firstByteLatency')}
								className='bg-muted rounded-full px-2 py-1'
							>
								{response.meta.latencyMs} ms
							</span>
						)}
						{response.meta.contentType && (
							<span className='bg-muted max-w-full truncate rounded-full px-2 py-1'>
								{response.meta.contentType}
							</span>
						)}
					</div>
				)}
			</div>
			{!response || !view ? (
				<p className='text-muted-foreground text-sm'>
					{t('cinatoken.adminSimulator.emptyResponseHint')}
				</p>
			) : (
				<>
					<div className='flex flex-wrap gap-2 border-b pb-2'>
						<div
							role='group'
							aria-label={t('cinatoken.adminSimulator.response')}
							className='flex gap-2'
						>
							{(['merged', 'raw'] as const).map((value) => (
								<button
									type='button'
									key={value}
									aria-pressed={tab === value}
									className={
										'rounded-md border px-3 py-1.5 text-sm ' +
										(tab === value ? 'border-primary bg-primary/10' : '')
									}
									onClick={() => setTab(value)}
								>
									{t(
										value === 'merged'
											? 'cinatoken.adminSimulator.tabMerged'
											: 'cinatoken.adminSimulator.tabRaw'
									)}
								</button>
							))}
						</div>
						{props.canReadLogs && (
							<a
								href={snapshotLogsHref(response.snapshot)}
								className='text-primary ml-auto self-center text-xs underline'
							>
								{t(
									response.snapshot.selection.kind === 'tool'
										? 'cinatoken.adminSimulator.openToolsInvocations'
										: 'cinatoken.adminSimulator.openRequestLogs'
								)}
							</a>
						)}
					</div>
					<p role='status' className='text-muted-foreground text-xs'>
						{t('cinatoken.adminSimulator.outcomes.' + response.meta.outcome)}
					</p>
					{(response.meta.outcome === 'unknown' ||
						response.meta.outcome === 'cancelled') && (
						<p className='rounded-md border border-amber-300 p-3 text-sm text-amber-800 dark:text-amber-300'>
							{t('cinatoken.adminSimulator.unknownChargeHint')}
						</p>
					)}
					{response.meta.status === null &&
						response.meta.outcome === 'failed' &&
						response.snapshot.wire.method === 'WebSocket' && (
							<p role='alert' className='text-destructive text-sm'>
								{t('cinatoken.adminSimulator.handshakeRejected')}
							</p>
						)}
					{view.budgetError && (
						<p
							role='alert'
							className='border-destructive text-destructive rounded-md border p-3 text-sm'
						>
							{t('cinatoken.adminSimulator.budgetError')}
						</p>
					)}
					{view.usage && (
						<p className='bg-muted/40 rounded-md border p-3 text-sm'>
							<span className='font-medium'>
								{t('cinatoken.adminSimulator.usagePreview')}
							</span>
							{view.usage}
						</p>
					)}
					{tab === 'raw' ? (
						<pre ref={scroll} className={codeBlockClass + ' max-h-[65vh]'}>
							{response.raw || t('cinatoken.adminSimulator.receiving')}
						</pre>
					) : (
						<>
							{view.images.length > 0 && (
								<div className='space-y-2'>
									<h3 className='text-sm font-medium'>
										{t('cinatoken.adminSimulator.imagePreview')}
									</h3>
									<div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
										{view.images.map((image, index) => (
											<a
												key={index}
												href={image.src}
												target='_blank'
												rel='noreferrer'
												className='overflow-hidden rounded-md border'
											>
												<img
													src={image.src}
													alt={t('cinatoken.adminSimulator.imageNumber', {
														number: index + 1,
													})}
													className='h-auto w-full object-contain'
													loading='lazy'
													referrerPolicy='no-referrer'
												/>
											</a>
										))}
									</div>
								</div>
							)}
							{response.audio && <SimulatorAudio blob={response.audio} />}
							{!response.audio && view.images.length === 0 && (
								<div className='space-y-3'>
									<div>
										<h3 className='mb-1 text-xs font-medium'>
											{t('cinatoken.adminSimulator.thinkingReasoning')}
										</h3>
										<pre className={codeBlockClass + ' max-h-52'}>
											{view.reasoning || '—'}
										</pre>
									</div>
									<div>
										<h3 className='mb-1 text-xs font-medium'>
											{t('cinatoken.adminSimulator.body')}
										</h3>
										<pre
											ref={scroll}
											className={codeBlockClass + ' max-h-[52vh]'}
										>
											{view.body || t('cinatoken.adminSimulator.receiving')}
										</pre>
									</div>
								</div>
							)}
						</>
					)}
					<details className='rounded-md border p-3'>
						<summary className='cursor-pointer text-xs'>
							{t('cinatoken.adminSimulator.actualRequest')}
						</summary>
						<dl className='mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs break-all'>
							<dt>{t('cinatoken.adminSimulator.apiKeyRowId')}</dt>
							<dd>{response.snapshot.keyId}</dd>
							<dt>{t('cinatoken.adminSimulator.owner')}</dt>
							<dd>{response.snapshot.ownerId}</dd>
							<dt>{t('cinatoken.adminSimulator.workspace')}</dt>
							<dd>{response.snapshot.workspaceId}</dd>
							{response.meta.generationId && (
								<>
									<dt>{t('cinatoken.adminSimulator.generationId')}</dt>
									<dd>{response.meta.generationId}</dd>
								</>
							)}
						</dl>
						<pre className={codeBlockClass + ' mt-3'}>
							{response.snapshot.wire.method} {response.snapshot.wire.url}
							{'\n'}
							{JSON.stringify(response.snapshot.wire.headers, null, 2)}
							{'\n'}
							{response.snapshot.wire.bodyText}
						</pre>
					</details>
				</>
			)}
		</section>
	)
}
