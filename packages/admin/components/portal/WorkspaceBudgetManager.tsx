'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePortalWorkspace } from '@/components/portal/PortalWorkspaceContext';
import { readPortalJson } from '@/lib/portal-fetch';

const INTERVALS = ['daily', 'weekly', 'monthly', 'lifetime'] as const;
type Interval = (typeof INTERVALS)[number];

type WorkspaceBudget = {
	id: string;
	workspaceId: string;
	limitUsd: number;
	resetInterval: Interval;
	createdAt: string;
	updatedAt: string;
};

const EMPTY_DRAFTS: Record<Interval, string> = {
	daily: '',
	weekly: '',
	monthly: '',
	lifetime: '',
};

function intervalKey(interval: Interval) {
	return `interval_${interval}` as const;
}

export default function WorkspaceBudgetManager() {
	const t = useTranslations('portal.workspaceBudgets');
	const locale = useLocale();
	const { context, isSwitching } = usePortalWorkspace();
	const workspace = context?.currentWorkspace;
	const workspaceId = workspace?.id ?? '';
	const canManage = workspace?.role === 'owner' || workspace?.role === 'admin';
	const [rows, setRows] = useState<WorkspaceBudget[]>([]);
	const [drafts, setDrafts] = useState<Record<Interval, string>>(EMPTY_DRAFTS);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [isMutating, startMutation] = useTransition();

	const load = useCallback(async (signal?: AbortSignal) => {
		if (!workspaceId) {
			setRows([]);
			setIsLoading(false);
			return;
		}
		setIsLoading(true);
		try {
			const response = await fetch('/api/user/workspace-budgets', { cache: 'no-store', signal });
			const result = await readPortalJson<WorkspaceBudget[]>(response);
			if (signal?.aborted) return;
			if (!response.ok || !result?.success) {
				setRows([]);
				setError(result?.message ?? t('loadFailed'));
				return;
			}
			const nextRows = result.data ?? [];
			if (nextRows.some((row) => row.workspaceId !== workspaceId)) {
				setRows([]);
				setError(t('loadFailed'));
				return;
			}
			setRows(nextRows);
			setError('');
		} catch (cause) {
			if (signal?.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return;
			setRows([]);
			setError(t('loadFailed'));
		} finally {
			if (!signal?.aborted) setIsLoading(false);
		}
	}, [t, workspaceId]);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const save = (interval: Interval) => {
		if (!canManage || isMutating) return;
		const limitUsd = Number(drafts[interval]);
		if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
			setError(t('invalidLimit'));
			return;
		}
		setError('');
		setNotice('');
		startMutation(async () => {
			try {
				const response = await fetch(`/api/user/workspace-budgets/${interval}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ limit_usd: limitUsd }),
				});
				const result = await readPortalJson<WorkspaceBudget>(response);
				if (!response.ok || !result?.success || !result.data) {
					setError(result?.message ?? t('saveFailed'));
					return;
				}
				if (result.data.workspaceId !== workspaceId) return;
				setRows((current) => [
					...current.filter((row) => row.resetInterval !== interval),
					result.data!,
				]);
				setDrafts((current) => ({ ...current, [interval]: '' }));
				setNotice(t('saved'));
			} catch {
				setError(t('saveFailed'));
			}
		});
	};

	const remove = (interval: Interval) => {
		if (!canManage || isMutating || !window.confirm(t('confirmDelete', { interval: t(intervalKey(interval)) }))) return;
		setError('');
		setNotice('');
		startMutation(async () => {
			try {
				const response = await fetch(`/api/user/workspace-budgets/${interval}`, { method: 'DELETE' });
				const result = await readPortalJson<never>(response);
				if (!response.ok || !result?.success) {
					setError(result?.message ?? t('deleteFailed'));
					return;
				}
				setRows((current) => current.filter((row) => row.resetInterval !== interval));
				setNotice(t('deleted'));
			} catch {
				setError(t('deleteFailed'));
			}
		});
	};

	const money = new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 6,
	});

	return (
		<section className="console-panel rounded-xl border p-5" style={{ borderColor: 'var(--console-border)' }}>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h2 className="text-base font-semibold">{t('title')}</h2>
					<p className="console-muted mt-1 text-sm">{t('subtitle')}</p>
				</div>
				<span className="console-badge self-start rounded-full px-2.5 py-1 text-xs">
					{canManage ? t('editable') : t('readOnly')}
				</span>
			</div>

			{error && <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
			{notice && <div role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

			<div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
				{INTERVALS.map((interval) => {
					const row = rows.find((candidate) => candidate.resetInterval === interval);
					return (
						<div key={interval} className="rounded-lg border p-4" style={{ borderColor: 'var(--console-border)' }}>
							<div className="text-sm font-medium">{t(intervalKey(interval))}</div>
							<div className="mt-2 text-xl font-semibold">{row ? money.format(row.limitUsd) : t('notConfigured')}</div>
							<div className="console-muted mt-1 min-h-8 text-xs">{t(`reset_${interval}`)}</div>
							{canManage && (
								<div className="mt-3 space-y-2">
									<input
										type="number"
										min="0.000001"
										step="0.000001"
										value={drafts[interval]}
										onChange={(event) => setDrafts((current) => ({ ...current, [interval]: event.target.value }))}
										placeholder={row ? String(row.limitUsd) : t('limitPlaceholder')}
										aria-label={t('limitLabel', { interval: t(intervalKey(interval)) })}
										className="console-input w-full rounded-lg border px-3 py-2 text-sm"
										disabled={isSwitching || isMutating}
									/>
									<div className="flex gap-2">
										<button type="button" onClick={() => save(interval)} disabled={isSwitching || isMutating || !drafts[interval]} className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">{t('save')}</button>
										{row && <button type="button" onClick={() => remove(interval)} disabled={isSwitching || isMutating} className="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-40" style={{ borderColor: 'var(--console-border)' }}>{t('delete')}</button>}
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>
			{isLoading && <div className="console-muted mt-3 text-xs">{t('loading')}</div>}
			<p className="console-muted mt-4 text-xs">{t('ordering')}</p>
		</section>
	);
}
