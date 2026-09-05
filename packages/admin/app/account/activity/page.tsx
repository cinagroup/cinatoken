'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { formatGatewayMoneyCode, formatGatewayMoneyCompact } from '@/lib/format-gateway-currency';
import { readPortalJson } from '@/lib/portal-fetch';
import { usePortalWorkspace } from '@/components/portal/PortalWorkspaceContext';
import WorkspaceBudgetManager from '@/components/portal/WorkspaceBudgetManager';
import ActivityBreakdown, { type ActivityGroup } from './ActivityBreakdown';
import ActivityGenerationDetail from './ActivityGenerationDetail';
import ActivityTimeline, { type ActivityTimelinePoint } from './ActivityTimeline';

type ActivityRange = '7d' | '30d' | '90d';

type ActivityData = {
	workspaceId: string;
	billingCurrency: string;
	range: { id: ActivityRange; startAt: string; endAt: string };
	budget: {
		status: 'finite' | 'unlimited' | 'unavailable';
		budgetMax: number | null;
		budgetBase: number | null;
		budgetSpent: number | null;
		budgetReserved: number | null;
		budgetReservedMicros: number | null;
		budgetRemaining: number | null;
		budgetPeriod: string;
		budgetResetAt: string | null;
	};
	summary: {
		totalRequests: number;
		errorCount: number;
		successCount: number;
		chargedCost: number;
		meteredCost: number;
		standardCost: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
		avgLatencyMs: number | null;
	};
	analytics: {
		limit: number;
		models: ActivityGroup[];
		apiKeys: ActivityGroup[];
		providers: ActivityGroup[];
	};
	timeline: {
		granularity: 'hour' | 'day';
		points: ActivityTimelinePoint[];
	};
	keys: Array<{ id: string; name: string | null; status: string }>;
	logs: Array<{
		id: string;
		apiKeyId: string | null;
		apiKeyName: string | null;
		modelId: string | null;
		modelName: string | null;
		providerName: string | null;
		protocol: string | null;
		operation: string | null;
		status: string;
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		chargedCost: number;
		latencyMs: number | null;
		billingKind: string | null;
		inputImageCount: number;
		outputImageCount: number;
		audioDurationSeconds: number | null;
		audioCharacters: number | null;
		createdAt: string;
	}>;
	pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

const STATUS_STYLES: Record<string, string> = {
	success: 'bg-emerald-50 text-emerald-700',
	error: 'bg-red-50 text-red-700',
	incomplete: 'bg-amber-50 text-amber-700',
	cancelled: 'bg-gray-100 text-gray-600',
	unknown: 'bg-gray-100 text-gray-600',
};
const GENERATION_ID_PATTERN = /^gen-[A-Za-z0-9_-]{1,128}$/;

function statusTranslationKey(status: string):
	| 'status_success'
	| 'status_error'
	| 'status_incomplete'
	| 'status_cancelled'
	| 'status_unknown' {
	if (status === 'success' || status === 'error' || status === 'incomplete' || status === 'cancelled') {
		return `status_${status}`;
	}
	return 'status_unknown';
}

function buildQuery(
	range: ActivityRange,
	status: string,
	apiKeyId: string,
	modelId: string,
	providerName: string,
	page?: number,
): string {
	const query = new URLSearchParams({ range });
	if (status) query.set('status', status);
	if (apiKeyId) query.set('api_key_id', apiKeyId);
	if (modelId) query.set('model_id', modelId);
	if (providerName) query.set('provider_name', providerName);
	if (page != null) query.set('page', String(page));
	return query.toString();
}

export default function AccountActivityPage() {
	const t = useTranslations('portal.activity');
	const tCommon = useTranslations('portal.common');
	const locale = useLocale();
	const { context, isSwitching } = usePortalWorkspace();
	const workspaceId = context?.currentWorkspace.id ?? '';
	const workspaceName = context?.currentWorkspace.name ?? workspaceId;
	const [range, setRange] = useState<ActivityRange>('7d');
	const [status, setStatus] = useState('');
	const [apiKeyId, setApiKeyId] = useState('');
	const [modelDraft, setModelDraft] = useState('');
	const [modelId, setModelId] = useState('');
	const [providerName, setProviderName] = useState('');
	const [page, setPage] = useState(1);
	const [data, setData] = useState<ActivityData | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState('');
	const [selectedGeneration, setSelectedGeneration] = useState<{ id: string; chargedCost: number } | null>(null);

	useEffect(() => {
		setApiKeyId('');
		setModelDraft('');
		setModelId('');
		setProviderName('');
		setPage(1);
		setData(null);
		setSelectedGeneration(null);
	}, [workspaceId]);

	useEffect(() => {
		if (!workspaceId || isSwitching) return;
		const controller = new AbortController();
		setIsLoading(true);
		setError('');
		void (async () => {
			try {
				const response = await fetch(
					`/api/user/activity?${buildQuery(range, status, apiKeyId, modelId, providerName, page)}`,
					{ cache: 'no-store', signal: controller.signal },
				);
				const payload = await readPortalJson<ActivityData>(response);
				if (!response.ok || !payload?.success || !payload.data || payload.data.workspaceId !== workspaceId) {
					throw new Error(payload?.message || t('loadFailed'));
				}
				setData(payload.data);
			} catch (loadError) {
				if (controller.signal.aborted) return;
				setError(loadError instanceof Error ? loadError.message : t('loadFailed'));
			} finally {
				if (!controller.signal.aborted) setIsLoading(false);
			}
		})();
		return () => controller.abort();
	}, [apiKeyId, isSwitching, modelId, page, providerName, range, status, t, workspaceId]);

	const exportUrl = useMemo(
		() => `/api/user/activity/export.csv?${buildQuery(range, status, apiKeyId, modelId, providerName)}`,
		[apiKeyId, modelId, providerName, range, status],
	);

	const submitModel = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setPage(1);
		setModelId(modelDraft.trim());
	};

	const selectModel = (id: string) => {
		setModelDraft(id);
		setModelId(id);
		setPage(1);
	};

	const selectApiKey = (id: string) => {
		setApiKeyId(id);
		setPage(1);
	};
	const selectProvider = (name: string) => {
		setProviderName(name);
		setPage(1);
	};
	const closeGenerationDetails = useCallback(() => setSelectedGeneration(null), []);

	const currency = data?.billingCurrency ?? 'USD';
	const successRate = data && data.summary.totalRequests > 0
		? Math.round((data.summary.successCount / data.summary.totalRequests) * 1_000) / 10
		: 0;
	const budgetValue = data?.budget.status === 'finite' && data.budget.budgetRemaining != null
		? formatGatewayMoneyCode(data.budget.budgetRemaining, currency)
		: data?.budget.status === 'unlimited' ? t('unlimited') : '—';

	if (isLoading && !data) {
		return <div className="console-muted py-12 text-center text-sm">{tCommon('loading')}</div>;
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="text-2xl font-bold">{t('title')}</h1>
						<span className="console-badge rounded-full px-2.5 py-1 text-xs">{t('workspaceScope', { name: workspaceName })}</span>
					</div>
					<p className="console-muted mt-1 text-sm">{t('subtitle')}</p>
				</div>
				<a
					href={exportUrl}
					download
					className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-[var(--console-panel-subtle)]"
					style={{ borderColor: 'var(--console-border)' }}
				>
					<ArrowDownTrayIcon className="h-4 w-4" />
					{t('exportCsv')}
				</a>
			</div>

			{error && (
				<div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
					{error}
				</div>
			)}

			<WorkspaceBudgetManager key={workspaceId} />

			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<div className="console-panel rounded-xl border p-4" style={{ borderColor: 'var(--console-border)' }}>
					<div className="console-muted text-xs">{t('accountBudgetRemaining')}</div>
					<div className="mt-1 text-2xl font-semibold">{budgetValue}</div>
					<div className="console-muted mt-1 text-xs">
						{data?.budget.status === 'unavailable'
							? t('budgetUnavailable')
							: t('budgetSpentReserved', {
								spent: formatGatewayMoneyCode(data?.budget.budgetSpent ?? 0, currency),
								reserved: formatGatewayMoneyCode(data?.budget.budgetReserved ?? 0, currency),
							})}
					</div>
				</div>
				<div className="console-panel rounded-xl border p-4" style={{ borderColor: 'var(--console-border)' }}>
					<div className="console-muted text-xs">{t('requests')}</div>
					<div className="mt-1 text-2xl font-semibold">{(data?.summary.totalRequests ?? 0).toLocaleString(locale)}</div>
					<div className="console-muted mt-1 text-xs">{t('successRate', { rate: successRate })}</div>
				</div>
				<div className="console-panel rounded-xl border p-4" style={{ borderColor: 'var(--console-border)' }}>
					<div className="console-muted text-xs">{t('tokens')}</div>
					<div className="mt-1 text-2xl font-semibold">{(data?.summary.totalTokens ?? 0).toLocaleString(locale)}</div>
					<div className="console-muted mt-1 text-xs">
						{t('tokenBreakdown', {
							input: (data?.summary.inputTokens ?? 0).toLocaleString(locale),
							output: (data?.summary.outputTokens ?? 0).toLocaleString(locale),
						})}
					</div>
				</div>
				<div className="console-panel rounded-xl border p-4" style={{ borderColor: 'var(--console-border)' }}>
					<div className="console-muted text-xs">{t('chargedCost')}</div>
					<div className="mt-1 text-2xl font-semibold">{formatGatewayMoneyCode(data?.summary.chargedCost ?? 0, currency)}</div>
					<div className="console-muted mt-1 text-xs">
						{data?.summary.avgLatencyMs == null ? t('noLatency') : t('averageLatency', { value: Math.round(data.summary.avgLatencyMs) })}
					</div>
				</div>
			</div>

			<section className="console-panel rounded-xl border" style={{ borderColor: 'var(--console-border)' }}>
				<div className="border-b p-4" style={{ borderColor: 'var(--console-border)' }}>
					<form onSubmit={submitModel} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-[135px_150px_180px_180px_minmax(200px,1fr)_auto]">
						<label className="text-xs font-medium">
							<span className="console-muted mb-1 block">{t('range')}</span>
							<select
								value={range}
								onChange={(event) => { setRange(event.target.value as ActivityRange); setPage(1); }}
								className="console-input w-full rounded-lg border px-3 py-2 text-sm"
							>
								<option value="7d">{t('range7d')}</option>
								<option value="30d">{t('range30d')}</option>
								<option value="90d">{t('range90d')}</option>
							</select>
						</label>
						<label className="text-xs font-medium">
							<span className="console-muted mb-1 block">{t('status')}</span>
							<select
								value={status}
								onChange={(event) => { setStatus(event.target.value); setPage(1); }}
								className="console-input w-full rounded-lg border px-3 py-2 text-sm"
							>
								<option value="">{t('allStatuses')}</option>
								<option value="success">{t('status_success')}</option>
								<option value="error">{t('status_error')}</option>
								<option value="incomplete">{t('status_incomplete')}</option>
								<option value="cancelled">{t('status_cancelled')}</option>
							</select>
						</label>
						<label className="text-xs font-medium">
							<span className="console-muted mb-1 block">{t('apiKey')}</span>
							<select
								value={apiKeyId}
								onChange={(event) => { setApiKeyId(event.target.value); setPage(1); }}
								className="console-input w-full rounded-lg border px-3 py-2 text-sm"
							>
								<option value="">{t('allKeys')}</option>
								{data?.keys.map((key) => <option key={key.id} value={key.id}>{key.name || key.id}</option>)}
							</select>
						</label>
						<label className="text-xs font-medium">
							<span className="console-muted mb-1 block">{t('provider')}</span>
							<select
								value={providerName}
								onChange={(event) => { setProviderName(event.target.value); setPage(1); }}
								className="console-input w-full rounded-lg border px-3 py-2 text-sm"
							>
								<option value="">{t('allProviders')}</option>
								{data?.analytics.providers.map((provider) => (
									<option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
								))}
							</select>
						</label>
						<label className="text-xs font-medium">
							<span className="console-muted mb-1 block">{t('model')}</span>
							<input
								value={modelDraft}
								onChange={(event) => setModelDraft(event.target.value)}
								placeholder={t('modelPlaceholder')}
								maxLength={256}
								className="console-input w-full rounded-lg border px-3 py-2 text-sm"
							/>
						</label>
						<button type="submit" className="self-end rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700">
							{t('apply')}
						</button>
					</form>
				</div>

				<ActivityTimeline
					granularity={data?.timeline.granularity ?? (range === '7d' ? 'hour' : 'day')}
					points={data?.timeline.points ?? []}
					currency={currency}
					locale={locale}
				/>

				<ActivityBreakdown
					models={data?.analytics.models ?? []}
					apiKeys={data?.analytics.apiKeys ?? []}
					providers={data?.analytics.providers ?? []}
					limit={data?.analytics.limit ?? 10}
					currency={currency}
					locale={locale}
					onSelectModel={selectModel}
					onSelectApiKey={selectApiKey}
					onSelectProvider={selectProvider}
				/>

				<div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--console-border)' }}>
					<h2 className="text-sm font-semibold">{t('recentRequests')}</h2>
					{isLoading && <span className="console-muted text-xs">{tCommon('loading')}</span>}
				</div>

				{!data?.logs.length ? (
					<div className="console-muted px-4 py-12 text-center text-sm">{t('noActivity')}</div>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[1040px] text-left text-sm">
							<thead className="console-muted text-xs">
								<tr className="border-b" style={{ borderColor: 'var(--console-border)' }}>
									<th className="px-4 py-2.5 font-medium">{t('time')}</th>
									<th className="px-4 py-2.5 font-medium">{t('request')}</th>
									<th className="px-4 py-2.5 font-medium">{t('model')}</th>
									<th className="px-4 py-2.5 font-medium">{t('provider')}</th>
									<th className="px-4 py-2.5 font-medium">{t('apiKey')}</th>
									<th className="px-4 py-2.5 font-medium">{t('status')}</th>
									<th className="px-4 py-2.5 text-right font-medium">{t('usage')}</th>
									<th className="px-4 py-2.5 text-right font-medium">{t('cost')}</th>
									<th className="px-4 py-2.5 text-right font-medium">{t('latency')}</th>
								</tr>
							</thead>
							<tbody>
								{data.logs.map((row) => (
									<tr key={row.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--console-border)' }}>
										<td className="whitespace-nowrap px-4 py-3 text-xs">{new Date(row.createdAt).toLocaleString(locale)}</td>
										<td className="px-4 py-3">
											{GENERATION_ID_PATTERN.test(row.id) ? (
												<button
													type="button"
													onClick={() => setSelectedGeneration({ id: row.id, chargedCost: row.chargedCost })}
													className="rounded font-mono text-xs text-cyan-700 underline decoration-cyan-500/40 underline-offset-4 hover:text-cyan-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:text-cyan-300"
													title={row.id}
													aria-label={t('viewDetailsFor', { id: row.id })}
												>
													{row.id.slice(0, 16)}
												</button>
											) : (
												<code title={row.id} className="console-muted text-xs">{row.id.slice(0, 12)}</code>
											)}
										</td>
										<td className="max-w-52 px-4 py-3"><div className="truncate font-medium" title={row.modelId ?? ''}>{row.modelName || row.modelId || '—'}</div>{row.operation && <div className="console-muted mt-0.5 text-xs">{row.operation}</div>}</td>
										<td className="max-w-40 px-4 py-3"><div className="truncate" title={row.providerName ?? ''}>{row.providerName || '—'}</div></td>
										<td className="max-w-44 px-4 py-3"><div className="truncate" title={row.apiKeyId ?? ''}>{row.apiKeyName || row.apiKeyId || '—'}</div></td>
										<td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLES[row.status] ?? STATUS_STYLES.unknown}`}>{t(statusTranslationKey(row.status))}</span></td>
										<td className="px-4 py-3 text-right tabular-nums"><div>{row.totalTokens.toLocaleString(locale)}</div><div className="console-muted text-xs">{t('inputOutput', { input: row.inputTokens.toLocaleString(locale), output: row.outputTokens.toLocaleString(locale) })}</div></td>
										<td className="px-4 py-3 text-right font-mono text-xs tabular-nums">{formatGatewayMoneyCompact(row.chargedCost, currency)}</td>
										<td className="px-4 py-3 text-right tabular-nums">{row.latencyMs == null ? '—' : t('latencyValue', { value: Math.round(row.latencyMs) })}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				<div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: 'var(--console-border)' }}>
					<div className="console-muted text-xs">
						{t('pagination', {
							page: data?.pagination.page ?? 1,
							pages: data?.pagination.totalPages ?? 1,
							total: (data?.pagination.total ?? 0).toLocaleString(locale),
						})}
					</div>
					<div className="flex gap-2">
						<button type="button" disabled={page <= 1 || isLoading} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40" style={{ borderColor: 'var(--console-border)' }}>{tCommon('prevPage')}</button>
						<button type="button" disabled={page >= (data?.pagination.totalPages ?? 1) || isLoading} onClick={() => setPage((value) => value + 1)} className="rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40" style={{ borderColor: 'var(--console-border)' }}>{tCommon('nextPage')}</button>
					</div>
				</div>
			</section>

			{selectedGeneration && (
				<ActivityGenerationDetail
					id={selectedGeneration.id}
					locale={locale}
					billingCurrency={currency}
					chargedCost={selectedGeneration.chargedCost}
					onClose={closeGenerationDetails}
				/>
			)}
		</div>
	);
}
