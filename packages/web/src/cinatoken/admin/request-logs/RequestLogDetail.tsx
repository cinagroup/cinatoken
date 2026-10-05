/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { RequestLog } from './request-log-contracts'
import {
	normalizeRouteGroup,
	safeLogJson,
	safeLogText,
} from './request-log-domain'

const prefix = 'cinatoken.adminRequestLogs.'
function SummaryField(props: {
	label: string
	value: string | null | undefined
}) {
	return (
		<div className='min-w-0'>
			<dt className='text-muted-foreground text-xs font-semibold'>
				{props.label}
			</dt>
			<dd className='font-mono text-xs break-all'>
				{props.value?.trim() || '—'}
			</dd>
		</div>
	)
}
function RawPanel(props: {
	title: string
	raw: string | null | undefined
	copied: string | null
	onCopy: (text: string, title: string) => void
}) {
	const { t } = useTranslation()
	const display = safeLogJson(props.raw)
	return (
		<section className='bg-card min-w-0 rounded-lg border'>
			<header className='bg-muted/50 flex items-center justify-between gap-2 border-b px-3 py-2'>
				<h3 className='text-xs font-semibold'>{props.title}</h3>
				<Button
					type='button'
					variant='outline'
					size='sm'
					disabled={!display}
					onClick={() => {
						if (display) props.onCopy(display, props.title)
					}}
				>
					{t(prefix + (props.copied === props.title ? 'copied' : 'copy'))}
				</Button>
			</header>
			<pre className='max-h-96 min-h-28 overflow-auto p-3 font-mono text-xs break-words whitespace-pre-wrap'>
				{display || t(prefix + 'notAvailable')}
			</pre>
		</section>
	)
}
function ms(value: number | null | undefined): string {
	return value == null ? '—' : `${value.toLocaleString('en-US')} ms`
}
function timingDiagram(log: RequestLog): string {
	return [
		`Gateway            ${ms(log.gateway_overhead_ms)}`,
		`Upstream           ${ms(log.upstream_response_ms)}`,
		`Final headers      ${ms(log.final_upstream_headers_ms)}`,
		`Reasoning TTFT     ${ms(log.first_reasoning_token_ms)}`,
		`Content TTFT       ${ms(log.first_token_ms)}`,
		`Stream             ${ms(log.stream_duration_ms)}`,
		`Attempts           ${log.upstream_attempt_count ?? '—'}`,
		`Failover switches  ${log.upstream_failover_count ?? '—'}`,
	].join('\n')
}
export function RequestLogDetail(props: { log: RequestLog }) {
	const { t } = useTranslation()
	const [copied, setCopied] = useState<string | null>(null)
	const [copyFailed, setCopyFailed] = useState(false)
	async function copy(text: string, title: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text)
			setCopyFailed(false)
			setCopied(title)
			window.setTimeout(() => setCopied(null), 1500)
		} catch {
			setCopyFailed(true)
		}
	}
	const log = props.log
	const protocolMapping = `${[log.request_protocol, log.request_operation].filter(Boolean).join('.')} → ${[log.upstream_protocol, log.upstream_operation].filter(Boolean).join('.')}`
	const routeTarget = [
		log.model_surface_id && `surface ${log.model_surface_id}`,
		log.route_pool_id && `pool ${log.route_pool_id}`,
		log.route_target_id && `target ${log.route_target_id}`,
	]
		.filter(Boolean)
		.join(' · ')
	const providerKey = [
		log.provider_key_label,
		log.provider_key_fingerprint,
		log.provider_key_id,
	]
		.filter(Boolean)
		.join(' · ')
	const identifiers = [
		{
			title: t(prefix + 'detail.upstreamMessageId'),
			value: log.upstream_message_id,
		},
		{
			title: t(prefix + 'detail.upstreamRequestId'),
			value: log.upstream_request_id,
		},
	]
	return (
		<div className='space-y-4 p-3'>
			<dl className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
				<SummaryField label={t(prefix + 'detail.requestId')} value={log.id} />
				<SummaryField
					label={t(prefix + 'detail.identity')}
					value={[log.user_email, log.api_key_id].filter(Boolean).join(' · ')}
				/>
				<SummaryField
					label={t(prefix + 'detail.modelId')}
					value={log.model_id}
				/>
				<SummaryField
					label={t(prefix + 'detail.routeGroup')}
					value={normalizeRouteGroup(log.route_group)}
				/>
				<SummaryField
					label={t(prefix + 'detail.providerRoute')}
					value={[log.provider_name || log.provider_id, log.provider_model_name]
						.filter(Boolean)
						.join(' · ')}
				/>
				<SummaryField
					label={t(prefix + 'detail.protocolMapping')}
					value={protocolMapping}
				/>
				<SummaryField
					label={t(prefix + 'detail.providerKey')}
					value={providerKey}
				/>
				<SummaryField
					label={t(prefix + 'detail.routeTarget')}
					value={routeTarget}
				/>
			</dl>
			{log.error_message?.trim() && (
				<div className='border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-xs break-words'>
					<strong>{t(prefix + 'detail.error')}: </strong>
					{safeLogText(log.error_message.trim())}
				</div>
			)}
			<div className='grid gap-3 sm:grid-cols-2'>
				{identifiers
					.filter((item) => item.value?.trim())
					.map((item) => (
						<div
							key={item.title}
							className='bg-muted/30 flex min-w-0 items-center justify-between gap-2 rounded-lg border p-3'
						>
							<div className='min-w-0'>
								<p className='text-muted-foreground text-xs'>{item.title}</p>
								<p
									className='truncate font-mono text-xs'
									title={item.value ?? undefined}
								>
									{item.value}
								</p>
							</div>
							<Button
								size='sm'
								variant='outline'
								type='button'
								onClick={() => {
									if (item.value) void copy(item.value.trim(), item.title)
								}}
							>
								{t(prefix + (copied === item.title ? 'copied' : 'copy'))}
							</Button>
						</div>
					))}
			</div>
			{copyFailed && (
				<p role='alert' className='text-destructive text-xs'>
					{t(prefix + 'copyFailed')}
				</p>
			)}
			<div className='grid gap-3 xl:grid-cols-2 2xl:grid-cols-3'>
				<section className='bg-card rounded-lg border'>
					<header className='bg-muted/50 border-b px-3 py-2 text-xs font-semibold'>
						{t(prefix + 'detail.timing')}
					</header>
					<pre className='overflow-auto p-3 font-mono text-xs'>
						{timingDiagram(log)}
					</pre>
					<details className='border-t px-3 py-2 text-xs'>
						<summary className='cursor-pointer'>
							{t(prefix + 'timing.explain')}
						</summary>
						<dl className='text-muted-foreground mt-2 grid gap-1'>
							{(
								[
									'gateway',
									'upstream',
									'headers',
									'reasoning',
									'ttftContent',
									'stream',
									'attempts',
								] as const
							).map((key) => (
								<div key={key}>
									<strong>{t(prefix + `timing.${key}`)}: </strong>
									{t(prefix + `timing.${key}Desc`)}
								</div>
							))}
						</dl>
					</details>
				</section>
				<RawPanel
					title={t(prefix + 'timingJson')}
					raw={log.timing_metadata}
					copied={copied}
					onCopy={(text, title) => {
						void copy(text, title)
					}}
				/>
				<RawPanel
					title={t(prefix + 'detail.pricingAudit')}
					raw={log.pricing_audit}
					copied={copied}
					onCopy={(text, title) => {
						void copy(text, title)
					}}
				/>
				<RawPanel
					title={t(prefix + 'detail.entryRequestBody')}
					raw={log.request_body}
					copied={copied}
					onCopy={(text, title) => {
						void copy(text, title)
					}}
				/>
				<RawPanel
					title={t(prefix + 'detail.upstreamRequestBody')}
					raw={log.upstream_request_body}
					copied={copied}
					onCopy={(text, title) => {
						void copy(text, title)
					}}
				/>
				<RawPanel
					title={t(prefix + 'detail.upstreamUsageRaw')}
					raw={log.raw_usage}
					copied={copied}
					onCopy={(text, title) => {
						void copy(text, title)
					}}
				/>
				<RawPanel
					title={t(prefix + 'routeTrace')}
					raw={log.route_trace}
					copied={copied}
					onCopy={(text, title) => {
						void copy(text, title)
					}}
				/>
			</div>
		</div>
	)
}
