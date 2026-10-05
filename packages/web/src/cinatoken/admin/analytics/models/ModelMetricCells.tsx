/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type {
	ModelAnalyticsRow,
	ModelProviderRow,
} from './model-analytics-contracts'
import {
	formatAnalyticsMoney,
	formatTokens,
	ttftPrimary,
	type TokenMode,
} from './model-analytics-domain'

const prefix = 'cinatoken.adminModelAnalytics.'
type MetricRow = ModelAnalyticsRow | ModelProviderRow

function TtftCell(props: { row: MetricRow }) {
	const { t } = useTranslation()
	const primary = ttftPrimary(props.row)
	const fields = [
		['ttftReasoning', props.row.avg_first_reasoning_token_ms],
		['ttftContent', props.row.avg_first_token_ms],
		['ttftEffective', props.row.avg_effective_ttft_ms],
		['ttftPhase', props.row.avg_reasoning_phase_ms],
	] as const
	const tooltip = [
		...fields
			.filter(([, value]) => value !== null)
			.map(([key, value]) => `${t(prefix + key)}: ${Math.round(value!)} ms`),
		`${t(prefix + 'reasoningRate')}: ${props.row.reasoning_ttft_rate.toFixed(1)}%`,
		`${t(prefix + 'contentRate')}: ${props.row.content_ttft_rate.toFixed(1)}%`,
	].join('\n')
	if (!primary) return <span className='text-muted-foreground'>—</span>
	return (
		<span className='whitespace-nowrap tabular-nums' title={tooltip}>
			{primary.kind && (
				<strong className='bg-muted mr-1 rounded px-1 text-xs'>
					{primary.kind}
				</strong>
			)}
			{Math.round(primary.value)} ms
		</span>
	)
}

export function ModelMetricCells(props: {
	row: MetricRow
	kind: 'main' | 'detail'
	currency: 'USD' | 'CNY' | null
	locale: string
	tokenMode: TokenMode
}) {
	const { t } = useTranslation()
	function money(value: number | undefined, digits = 4): string {
		return (
			formatAnalyticsMoney(value, props.currency, props.locale, digits) ??
			(props.currency ? '—' : t(prefix + 'hidden'))
		)
	}
	function latency(value: number | null): string {
		return value === null ? '—' : `${Math.round(value)} ms`
	}
	return (
		<>
			<td className='px-3 py-3 tabular-nums'>
				{new Intl.NumberFormat(props.locale).format(props.row.request_count)}
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{formatTokens(props.row.input_tokens, props.tokenMode, props.locale)}
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{formatTokens(props.row.output_tokens, props.tokenMode, props.locale)}
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{props.row.cache_hit_rate.toFixed(1)}%
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{money(props.row.standard_cost)}
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{money(props.row.charged_cost)}
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{money(props.row.metered_cost)}
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{money(props.row.avg_charged_per_request, 6)}
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{props.row.success_rate.toFixed(1)}%
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{latency(props.row.avg_latency_ms)}
			</td>
			<td className='px-3 py-3'>
				<TtftCell row={props.row} />
			</td>
			{props.kind === 'main' && (
				<td className='px-3 py-3 tabular-nums'>
					{latency(props.row.avg_upstream_response_ms)}
				</td>
			)}
			<td className='px-3 py-3 tabular-nums'>
				{props.row.tokens_per_second === null
					? '—'
					: props.row.tokens_per_second.toFixed(1)}
			</td>
			<td className='px-3 py-3 tabular-nums'>
				{props.row.failover_rate.toFixed(1)}%
			</td>
			{props.kind === 'main' && (
				<td className='px-3 py-3 tabular-nums'>
					{props.row.avg_attempts === null
						? '—'
						: props.row.avg_attempts.toFixed(2)}
				</td>
			)}
		</>
	)
}
