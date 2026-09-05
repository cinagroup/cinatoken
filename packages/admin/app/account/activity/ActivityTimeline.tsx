'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts';
import { formatCompactTokens } from '@/lib/format-compact-tokens';
import { formatGatewayMoneyCompact } from '@/lib/format-gateway-currency';

export type ActivityTimelinePoint = {
	bucket: string;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	chargedCost: number;
	avgLatencyMs: number | null;
};

type TimelineMetric = 'requests' | 'tokens' | 'cost' | 'latency';

type ActivityTimelineProps = {
	granularity: 'hour' | 'day';
	points: ActivityTimelinePoint[];
	currency: string;
	locale: string;
};

function bucketLabel(bucket: string, granularity: 'hour' | 'day', locale: string): string {
	const date = new Date(bucket);
	return granularity === 'hour'
		? date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit' })
		: date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export default function ActivityTimeline({
	granularity,
	points,
	currency,
	locale,
}: ActivityTimelineProps) {
	const t = useTranslations('portal.activity');
	const [metric, setMetric] = useState<TimelineMetric>('requests');
	const metrics: Array<{ id: TimelineMetric; label: string }> = [
		{ id: 'requests', label: t('trendRequests') },
		{ id: 'tokens', label: t('trendTokens') },
		{ id: 'cost', label: t('trendCost') },
		{ id: 'latency', label: t('trendLatency') },
	];
	const data = useMemo(() => points.map((point) => ({
		label: bucketLabel(point.bucket, granularity, locale),
		value: metric === 'requests'
			? point.requestCount
			: metric === 'tokens'
				? point.totalTokens
				: metric === 'cost' ? point.chargedCost : point.avgLatencyMs,
	})), [granularity, locale, metric, points]);
	const hasValues = data.some((point) => point.value != null);
	const formatValue = (value: number): string => {
		if (metric === 'cost') return formatGatewayMoneyCompact(value, currency);
		if (metric === 'latency') return t('latencyValue', { value: Math.round(value) });
		if (metric === 'tokens') return value.toLocaleString(locale);
		return value.toLocaleString(locale);
	};
	const formatAxisValue = (value: number): string => {
		if (metric === 'cost') return formatGatewayMoneyCompact(value, currency);
		if (metric === 'latency') return `${Math.round(value)} ms`;
		return formatCompactTokens(value);
	};

	return (
		<section aria-labelledby="activity-timeline-title" className="border-b p-4 sm:p-5" style={{ borderColor: 'var(--console-border)' }}>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h2 id="activity-timeline-title" className="text-sm font-semibold">{t('usageTrend')}</h2>
					<p className="console-muted mt-0.5 text-xs">
						{t('trendSubtitle', { granularity: t(granularity === 'hour' ? 'hourly' : 'daily') })}
					</p>
				</div>
				<div role="group" aria-label={t('trendMetric')} className="flex max-w-full overflow-x-auto rounded-lg border p-1" style={{ borderColor: 'var(--console-border)' }}>
					{metrics.map((item) => (
						<button
							key={item.id}
							type="button"
							onClick={() => setMetric(item.id)}
							aria-pressed={metric === item.id}
							className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 ${metric === item.id ? 'console-badge' : 'console-muted hover:bg-[var(--console-panel-subtle)] hover:text-[var(--console-text)]'}`}
						>
							{item.label}
						</button>
					))}
				</div>
			</div>

			{points.length === 0 || !hasValues ? (
				<div className="console-muted py-16 text-center text-sm">{t('noTimelineData')}</div>
			) : (
				<div className="mt-4 h-64 w-full sm:h-72" role="img" aria-label={t('trendChartLabel', { metric: metrics.find((item) => item.id === metric)?.label ?? '' })}>
					<ResponsiveContainer width="100%" height="100%">
						<AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
							<CartesianGrid vertical={false} stroke="var(--console-border)" strokeDasharray="3 3" />
							<XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={28} tick={{ fill: 'var(--console-muted)', fontSize: 11 }} />
							<YAxis axisLine={false} tickLine={false} width={64} tickFormatter={formatAxisValue} tick={{ fill: 'var(--console-muted)', fontSize: 11 }} />
							<Tooltip
								cursor={{ stroke: 'var(--console-border)' }}
								content={({ active, payload, label }) => active && payload?.[0]?.value != null ? (
									<div className="console-panel rounded-lg border px-3 py-2 shadow-lg" style={{ borderColor: 'var(--console-border)' }}>
										<div className="console-muted text-xs">{String(label)}</div>
										<div className="mt-1 font-mono text-sm font-semibold">{formatValue(Number(payload[0].value))}</div>
									</div>
								) : null}
							/>
							<Area type="monotone" dataKey="value" stroke="var(--console-accent)" fill="var(--console-accent)" fillOpacity={0.12} strokeWidth={2} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} />
						</AreaChart>
					</ResponsiveContainer>
				</div>
			)}
		</section>
	);
}
