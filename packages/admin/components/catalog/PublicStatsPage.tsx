'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { PublicModelStatsResult } from '@/lib/public-catalog';

type Range = '7d' | '30d' | '90d';
type Metric = 'popular' | 'reliable' | 'latency';

function formatCompact(value: number, locale: string): string { return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value); }

export default function PublicStatsPage({ initial, mode }: { initial: PublicModelStatsResult; mode: 'rankings' | 'benchmarks' }) {
	const t = useTranslations(mode === 'rankings' ? 'publicRankings' : 'publicBenchmarks');
	const locale = useLocale();
	const [result, setResult] = useState(initial);
	const [range, setRange] = useState<Range>(initial.range);
	const [metric, setMetric] = useState<Metric>(mode === 'rankings' ? 'popular' : 'latency');
	const [loading, setLoading] = useState(false);

	const changeRange = async (next: Range) => {
		setRange(next); setLoading(true);
		try {
			const response = await fetch(`/api/public/stats?range=${next}`, { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(String(response.status));
			setResult(await response.json() as PublicModelStatsResult);
		} catch { setResult({ status: 'unavailable', models: [], range: next, windowStart: null, windowEnd: null, minimumSampleSize: initial.minimumSampleSize, generatedAt: null }); }
		finally { setLoading(false); }
	};

	const models = useMemo(() => [...result.models].sort((a, b) => {
		if (metric === 'reliable') return b.successRate - a.successRate || b.requestCount - a.requestCount;
		if (metric === 'latency') return (a.avgLatencyMs ?? Number.POSITIVE_INFINITY) - (b.avgLatencyMs ?? Number.POSITIVE_INFINITY) || b.requestCount - a.requestCount;
		return b.requestCount - a.requestCount;
	}), [metric, result.models]);

	return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12"><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start"><div><h1 className="home-text text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">{t('title')}</h1><p className="home-muted mt-3 max-w-3xl text-sm leading-6">{t('description')}</p></div><Link href="/models" className="home-action home-action-secondary inline-flex h-10 w-fit items-center rounded-lg px-4 text-sm font-medium">{t('browseModels')}</Link></div>
		<div className="mt-8 flex flex-wrap items-center justify-between gap-3"><div className="home-catalog-control flex rounded-lg border p-1">{(['7d','30d','90d'] as Range[]).map((value) => <button key={value} type="button" onClick={() => changeRange(value)} disabled={loading} className={`rounded-md px-3 py-1.5 text-sm ${range === value ? 'bg-[var(--home-menu-hover)] home-text' : 'home-muted home-hover-text'}`}>{t(`ranges.${value}`)}</button>)}</div><div className="home-catalog-control flex rounded-lg border p-1">{(['popular','reliable','latency'] as Metric[]).map((value) => <button key={value} type="button" onClick={() => setMetric(value)} className={`rounded-md px-3 py-1.5 text-sm ${metric === value ? 'bg-[var(--home-menu-hover)] home-text' : 'home-muted home-hover-text'}`}>{t(`metrics.${value}`)}</button>)}</div></div>
		<p className="home-faint mt-4 text-xs">{t('privacyNote', { count: result.minimumSampleSize })}</p>
		{result.status === 'unavailable' ? <div className="home-catalog-card mt-6 rounded-xl border p-10 text-center"><h2 className="home-text font-semibold">{t('unavailable.title')}</h2><p className="home-muted mt-2 text-sm">{t('unavailable.description')}</p></div> : models.length === 0 ? <div className="home-catalog-card mt-6 rounded-xl border p-10 text-center"><h2 className="home-text font-semibold">{t('empty.title')}</h2><p className="home-muted mt-2 text-sm">{t('empty.description', { count: result.minimumSampleSize })}</p></div> : <div className="home-catalog-card mt-6 overflow-x-auto rounded-xl border"><table className="w-full min-w-[720px] text-left text-sm"><thead><tr className="home-border border-b"><th className="home-faint px-4 py-3 text-xs">#</th>{['model','requests','success','latency','output'].map((key) => <th key={key} className="home-faint px-4 py-3 text-xs font-medium">{t(`columns.${key}`)}</th>)}</tr></thead><tbody>{models.map((model, index) => <tr key={`${model.vendor}:${model.slug}`} className="home-border border-b last:border-0"><td className="home-faint px-4 py-4 tabular-nums">{index + 1}</td><td className="px-4 py-4"><Link href={`/models/${encodeURIComponent(model.vendor)}/${encodeURIComponent(model.slug)}`} className="home-text font-medium hover:text-sky-500">{model.displayName}</Link><p className="home-faint mt-1 text-xs">{model.vendor}</p></td><td className="home-text px-4 py-4 tabular-nums">{formatCompact(model.requestCount, locale)}</td><td className="home-text px-4 py-4 tabular-nums">{model.successRate.toFixed(1)}%</td><td className="home-text px-4 py-4 tabular-nums">{model.avgLatencyMs == null ? '—' : `${Math.round(model.avgLatencyMs)} ms`}</td><td className="home-text px-4 py-4 tabular-nums">{formatCompact(model.outputTokens, locale)}</td></tr>)}</tbody></table></div>}
	</main>;
}
