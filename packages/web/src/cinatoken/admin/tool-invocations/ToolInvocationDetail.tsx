/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { ToolInvocation } from './tool-invocation-contracts'
import {
	safeResultHref,
	safeToolRaw,
	safeToolText,
	toolResponseSummary,
} from './tool-invocation-domain'

const prefix = 'cinatoken.adminToolInvocations.'
function RawPanel(props: {
	title: string
	raw: string | null | undefined
	copied: string | null
	onCopy: (text: string, title: string) => void
}) {
	const { t } = useTranslation()
	const display = safeToolRaw(props.raw)
	return (
		<section className='bg-card min-w-0 rounded-lg border'>
			<header className='bg-muted/50 flex items-center justify-between gap-2 border-b px-3 py-2'>
				<h3 className='text-xs font-semibold'>{props.title}</h3>
				<Button
					type='button'
					size='sm'
					variant='outline'
					disabled={!display}
					onClick={() => {
						if (display) props.onCopy(display, props.title)
					}}
				>
					{t(prefix + (props.copied === props.title ? 'copied' : 'copy'))}
				</Button>
			</header>
			<pre className='max-h-80 min-h-40 overflow-auto p-3 font-mono text-xs break-all whitespace-pre-wrap'>
				{display || t(prefix + 'notAvailable')}
			</pre>
		</section>
	)
}
export function ToolInvocationDetail(props: { log: ToolInvocation }) {
	const { t, i18n } = useTranslation()
	const [view, setView] = useState<'list' | 'json'>('list')
	const [copied, setCopied] = useState<string | null>(null)
	const [copyFailed, setCopyFailed] = useState(false)
	const response = toolResponseSummary(props.log.raw_usage)
	const responseDisplay = safeToolRaw(props.log.raw_usage)
	const ai = props.log.model_id === 'tool:ai-detection'
	async function copy(text: string, title: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text)
			setCopyFailed(false)
			setCopied(title)
		} catch {
			setCopyFailed(true)
		}
	}
	return (
		<div className='space-y-3 p-3 sm:p-4'>
			{props.log.error_message && (
				<p className='bg-destructive/10 text-destructive rounded-lg border p-3 text-xs break-all'>
					{safeToolText(props.log.error_message)}
				</p>
			)}
			{copyFailed && (
				<p role='alert' className='text-destructive text-xs'>
					{t(prefix + 'copyFailed')}
				</p>
			)}
			<div className='grid gap-4 lg:grid-cols-2'>
				<RawPanel
					title={t(prefix + 'invocations.detail.request')}
					raw={props.log.request_body}
					copied={copied}
					onCopy={(text, title) => {
						void copy(text, title)
					}}
				/>
				<section className='bg-card flex min-w-0 flex-col rounded-lg border'>
					<header className='bg-muted/50 flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2'>
						<h3 className='text-xs font-semibold'>
							{t(prefix + 'invocations.detail.response')}
						</h3>
						<div
							role='tablist'
							aria-label={t(prefix + 'invocations.detail.responseFormat')}
							className='flex items-center gap-1'
						>
							<Button
								type='button'
								role='tab'
								aria-selected={view === 'list'}
								size='sm'
								variant={view === 'list' ? 'default' : 'outline'}
								onClick={() => setView('list')}
							>
								{t(prefix + 'invocations.detail.formatList')}
							</Button>
							<Button
								type='button'
								role='tab'
								aria-selected={view === 'json'}
								size='sm'
								variant={view === 'json' ? 'default' : 'outline'}
								onClick={() => setView('json')}
							>
								{t(prefix + 'invocations.detail.formatJson')}
							</Button>
							<Button
								type='button'
								size='sm'
								variant='outline'
								disabled={!responseDisplay}
								onClick={() => {
									if (responseDisplay)
										void copy(
											responseDisplay,
											t(prefix + 'invocations.detail.response')
										)
								}}
							>
								{t(
									prefix +
										(copied === t(prefix + 'invocations.detail.response')
											? 'copied'
											: 'copy')
								)}
							</Button>
						</div>
					</header>
					{view === 'json' ? (
						<pre
							role='tabpanel'
							className='max-h-80 min-h-40 overflow-auto p-3 font-mono text-xs break-all whitespace-pre-wrap'
						>
							{responseDisplay ||
								t(prefix + 'invocations.detail.noResponseStored')}
						</pre>
					) : (
						<div
							role='tabpanel'
							className='max-h-80 min-h-40 overflow-auto p-3 text-xs'
						>
							{ai ? (
								<div className='space-y-3'>
									<div>
										{t(prefix + 'aiScore')}:{' '}
										{response.overallScore?.toLocaleString(
											i18n.resolvedLanguage || 'en',
											{ maximumFractionDigits: 4 }
										) ?? '—'}
									</div>
									<div>
										{t(prefix + 'segments')}: {response.segmentCount ?? '—'}
									</div>
									{response.segments.map((segment, index) => (
										<div key={index} className='bg-muted rounded p-2 font-mono'>
											{t(prefix + 'segment', {
												index: segment.index ?? index,
												chars: segment.chars ?? '—',
												score: segment.score ?? '—',
											})}
										</div>
									))}
									{!response.segments.length && (
										<p className='text-muted-foreground'>
											{props.log.raw_usage
												? t(prefix + 'invocations.detail.noListResults')
												: t(prefix + 'invocations.detail.noResponseStored')}
										</p>
									)}
								</div>
							) : response.results.length ? (
								<ul className='space-y-3'>
									{response.results.map((item, index) => {
										const href = safeResultHref(item.url)
										return (
											<li
												key={`${item.url ?? 'result'}-${index}`}
												className='min-w-0'
											>
												{href ? (
													<a
														href={href}
														target='_blank'
														rel='noreferrer noopener'
														className='text-primary break-all underline-offset-2 hover:underline'
													>
														{item.title || item.url}
													</a>
												) : (
													<span className='font-medium break-all'>
														{item.title || item.url || '—'}
													</span>
												)}
												{item.siteName && (
													<span className='text-muted-foreground ml-2'>
														{item.siteName}
													</span>
												)}
												{item.snippet && (
													<p className='text-muted-foreground mt-1 break-words'>
														{item.snippet}
													</p>
												)}
											</li>
										)
									})}
								</ul>
							) : (
								<p className='text-muted-foreground'>
									{props.log.raw_usage
										? t(prefix + 'invocations.detail.noListResults')
										: t(prefix + 'invocations.detail.noResponseStored')}
								</p>
							)}
						</div>
					)}
				</section>
			</div>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'invocations.detail.hint')}
			</p>
		</div>
	)
}
