/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { playgroundCode } from './PlaygroundSetup'
import {
	imageRequestMetaFromBody,
	parseImagesGenerationsResponse,
} from './browser-domain/image-generations'
import {
	inferPlaygroundParseMode,
	mergeAssistantTextParts,
} from './browser-domain/merge-assistant-text'
import { observePlaygroundResponse } from './browser-domain/response-observations'
import { summarizeResponsesSseEvents } from './browser-domain/sse-event-summary'
import {
	parseLastStreamUsage,
	tryParseUsageSummary,
} from './browser-domain/usage-parsing'
import { playgroundPrefix as prefix } from './playground-domain'
import type { PlaygroundResult } from './use-playground-run'

function parseRequest(text: string): Record<string, unknown> {
	try {
		return JSON.parse(text) as Record<string, unknown>
	} catch {
		return {}
	}
}
function safeImage(src: string): boolean {
	return (
		/^https?:\/\//i.test(src) ||
		/^data:image\/(png|jpeg|webp|gif);base64,/i.test(src)
	)
}
export function PlaygroundResponse(props: {
	result: PlaygroundResult | null
	busy: boolean
	onClear: () => void
}) {
	const { t } = useTranslation(),
		[tab, setTab] = useState<'merged' | 'raw'>('merged'),
		raw = useDeferredValue(props.result?.raw ?? '')
	const mode =
		inferPlaygroundParseMode(props.result?.meta?.contentType) ?? 'json'
	const parts = useMemo(
		() =>
			mergeAssistantTextParts(raw, props.result?.protocol ?? 'openai', mode),
		[raw, props.result?.protocol, mode]
	)
	const images = useMemo(
		() =>
			props.result?.kind === 'image'
				? parseImagesGenerationsResponse(
						raw,
						imageRequestMetaFromBody(parseRequest(props.result.requestBody))
					)
				: null,
		[raw, props.result]
	)
	const tags = useMemo(
		() =>
			props.result?.kind === 'llm'
				? observePlaygroundResponse({
						raw,
						protocol: props.result.protocol,
						contentType: props.result.meta?.contentType,
						requestBodyText: props.result.requestBody,
					})
				: [],
		[raw, props.result]
	)
	const summary = useMemo(
		() =>
			props.result?.protocol === 'openai' && props.result.kind === 'llm'
				? summarizeResponsesSseEvents(raw)
				: null,
		[raw, props.result]
	)
	const usage =
		mode === 'sse' || mode === 'ndjson'
			? parseLastStreamUsage(raw, props.result?.protocol ?? 'openai')
			: tryParseUsageSummary(raw, props.result?.protocol ?? 'openai')
	const end = useRef<HTMLPreElement | null>(null)
	useEffect(() => {
		if (props.busy && end.current)
			end.current.scrollTop = end.current.scrollHeight
	}, [raw, props.busy])
	return (
		<section className='min-w-0 space-y-4 rounded-xl border p-4'>
			<div className='flex flex-wrap items-center justify-between gap-2'>
				<h2 className='font-semibold'>{t(prefix + 'response')}</h2>
				<div className='flex flex-wrap gap-2'>
					<Button
						size='sm'
						variant={tab === 'merged' ? 'default' : 'outline'}
						aria-pressed={tab === 'merged'}
						onClick={() => setTab('merged')}
					>
						{t(prefix + 'tabMerged')}
					</Button>
					<Button
						size='sm'
						variant={tab === 'raw' ? 'default' : 'outline'}
						aria-pressed={tab === 'raw'}
						onClick={() => setTab('raw')}
					>
						{t(prefix + 'tabRaw')}
					</Button>
					<Button
						size='sm'
						variant='outline'
						disabled={props.busy}
						onClick={props.onClear}
					>
						{t(prefix + 'clear')}
					</Button>
				</div>
			</div>
			{props.busy ? (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + 'receiving')}
				</p>
			) : null}
			{props.result?.meta ? (
				<>
					<dl className='grid gap-2 text-xs sm:grid-cols-3'>
						<div>
							<dt>{t(prefix + 'status')}</dt>
							<dd>
								{props.result.meta.status}
								{props.result.meta.upstreamStatus
									? ' / ' + props.result.meta.upstreamStatus
									: ''}
							</dd>
						</div>
						<div>
							<dt>{t(prefix + 'latency')}</dt>
							<dd>{props.result.meta.latencyMs ?? '—'} ms</dd>
						</div>
						<div>
							<dt>{t(prefix + 'contentType')}</dt>
							<dd className='break-all'>{props.result.meta.contentType}</dd>
						</div>
					</dl>
					{props.result.meta.latencyScope ? (
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'latencyScope', {
								scope: props.result.meta.latencyScope,
							})}
						</p>
					) : null}
					{props.result.meta.outcome ? (
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'outcome', { value: props.result.meta.outcome })}
						</p>
					) : null}
				</>
			) : null}
			{tags.length ? (
				<div className='flex flex-wrap gap-2'>
					{tags.map((tag) => (
						<span
							key={tag.id}
							className={
								'rounded-full border px-2 py-1 text-xs ' +
								(tag.tone === 'warning'
									? 'border-amber-500 text-amber-700 dark:text-amber-300'
									: '')
							}
						>
							{t(prefix + tag.messageKey, {
								count: tag.count,
								reason: tag.finishReason,
							})}
						</span>
					))}
				</div>
			) : null}
			{summary ? (
				<details>
					<summary className='cursor-pointer text-xs'>
						{t(prefix + 'sseEventSummary')}
					</summary>
					<ul className='mt-2 space-y-1 text-xs'>
						<li>
							{t(prefix + 'sseOutputTextDeltas', {
								count: summary.outputTextDeltaCount,
							})}
						</li>
						<li>
							{t(prefix + 'sseToolArgDeltas', {
								count: summary.functionCallArgumentDeltaCount,
							})}
						</li>
						<li>
							{t(prefix + 'sseToolArgDone', {
								status: t(
									prefix +
										(summary.functionCallArgumentsDone
											? 'sseToolArgDoneYes'
											: 'sseToolArgDoneNo'),
									{ chars: summary.functionCallArgumentsDoneChars }
								),
							})}
						</li>
						<li>
							{t(
								prefix +
									{
										incremental: 'sseVerdictIncremental',
										bulk: 'sseVerdictBulk',
										no_tool: 'sseVerdictNoTool',
									}[summary.verdict]
							)}
						</li>
					</ul>
				</details>
			) : null}
			{usage ? (
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'usageDisplayOnly')}
					{usage}
				</p>
			) : null}
			{props.result ? (
				tab === 'raw' ? (
					<pre ref={end} className={playgroundCode + ' max-h-[36rem] min-h-60'}>
						{raw ||
							(props.result.audio
								? t(prefix + 'audioResponseReceived', {
										bytes: props.result.audio.size,
									})
								: '—')}
					</pre>
				) : (
					<div className='space-y-3'>
						{images?.count ? (
							<div className='space-y-3'>
								<h3 className='text-sm'>{t(prefix + 'imagePreview')}</h3>
								<div className='grid gap-3 sm:grid-cols-2'>
									{images.images
										.filter((image) => safeImage(image.src))
										.map((image, index) => (
											<figure
												key={index}
												className='min-w-0 rounded-md border p-2'
											>
												<img
													src={image.src}
													alt={t(prefix + 'imageAlt', { index: index + 1 })}
													loading='lazy'
													referrerPolicy='no-referrer'
													className='max-h-80 w-full object-contain'
												/>
												<a
													href={image.src}
													download={`image-${index + 1}.png`}
													target='_blank'
													rel='noreferrer'
													className='text-primary text-xs underline'
												>
													{t(prefix + 'downloadImage')}
												</a>
											</figure>
										))}
								</div>
								<p className='text-muted-foreground text-xs'>
									{images.usageHint}
								</p>
							</div>
						) : null}
						{props.result.audio ? (
							<BlobAudio blob={props.result.audio} />
						) : null}
						{!images?.count && !props.result.audio ? (
							<>
								<div>
									<h3 className='mb-1 text-sm'>{t(prefix + 'thinking')}</h3>
									<pre className={playgroundCode + ' min-h-20'}>
										{parts.reasoning || '—'}
									</pre>
								</div>
								<div>
									<h3 className='mb-1 text-sm'>{t(prefix + 'body')}</h3>
									<pre
										ref={end}
										className={playgroundCode + ' max-h-[36rem] min-h-48'}
									>
										{parts.body ||
											(props.result.kind === 'tool' ||
											props.result.kind === 'rerank' ||
											mode === 'text'
												? raw
												: t(prefix + 'cannotExtractBody'))}
									</pre>
								</div>
							</>
						) : null}
					</div>
				)
			) : (
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'emptyResponseHint')}
				</p>
			)}
			<ObservationLegend />
		</section>
	)
}
function BlobAudio(props: { blob: Blob }) {
	const { t } = useTranslation(),
		[url, setUrl] = useState<string | null>(null)
	useEffect(() => {
		const value = URL.createObjectURL(props.blob)
		let active = true
		queueMicrotask(() => {
			if (active) setUrl(value)
		})
		return () => {
			active = false
			URL.revokeObjectURL(value)
		}
	}, [props.blob])
	return (
		<div className='space-y-2'>
			<h3 className='text-sm'>{t(prefix + 'audioPreview')}</h3>
			{url ? (
				<>
					<audio controls src={url} className='w-full' />
					<a
						className='text-primary text-xs underline'
						href={url}
						download='speech-output'
					>
						{t(prefix + 'downloadAudio')}
					</a>
				</>
			) : null}
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'audioResponseReceived', { bytes: props.blob.size })}
			</p>
		</div>
	)
}
function ObservationLegend() {
	const { t } = useTranslation(),
		rows = [
			['obsShapeSse', 'obsHelpShapeSse'],
			['obsShapeJson', 'obsHelpShapeJson'],
			['obsShapeNdjson', 'obsHelpShapeNdjson'],
			['obsBody', 'obsHelpBody'],
			['obsBodyDeltas', 'obsHelpBodyDeltas'],
			['obsEmptyBody', 'obsHelpEmptyBody'],
			['obsReasoning', 'obsHelpReasoning'],
			['obsToolIncremental', 'obsHelpToolIncremental'],
			['obsToolBulk', 'obsHelpToolBulk'],
			['obsTool', 'obsHelpTool'],
			['obsNoTool', 'obsHelpNoTool'],
			['obsHelpFinishLabel', 'obsHelpFinish'],
		]
	return (
		<details>
			<summary className='cursor-pointer text-sm'>
				{t(prefix + 'obsHelpTitle')}
			</summary>
			<p className='text-muted-foreground my-2 text-xs'>
				{t(prefix + 'obsHelpIntro')}
			</p>
			<dl className='grid gap-2 text-xs sm:grid-cols-2'>
				{rows.map(([label, description]) => (
					<div key={label}>
						<dt className='font-medium'>{t(prefix + label, { count: 3 })}</dt>
						<dd className='text-muted-foreground'>{t(prefix + description)}</dd>
					</div>
				))}
			</dl>
		</details>
	)
}
