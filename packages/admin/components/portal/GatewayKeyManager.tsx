'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { usePortalWorkspace } from '@/components/portal/PortalWorkspaceContext';
import { readPortalJson } from '@/lib/portal-fetch';

type GatewayKeyRow = {
	id: string;
	workspaceId: string;
	key: string;
	name: string | null;
	status: string;
	limit: number | null;
	limitReset: 'daily' | 'weekly' | 'monthly' | null;
	expiresAt: string | null;
	lastUsedAt: string | null;
	createdAt: string;
};

type CreatedGatewayKey = {
	key: string;
	key_id: string;
	workspace_id: string;
};

function resetTranslationKey(reset: GatewayKeyRow['limitReset']) {
	switch (reset) {
		case 'daily': return 'resetDaily' as const;
		case 'weekly': return 'resetWeekly' as const;
		case 'monthly': return 'resetMonthly' as const;
		default: return 'resetLifetime' as const;
	}
}

export default function GatewayKeyManager() {
	const t = useTranslations('portal.gatewayKeys');
	const { context, isSwitching } = usePortalWorkspace();
	const workspaceId = context?.currentWorkspace.id ?? '';
	const workspaceName = context?.currentWorkspace.name ?? '';
	const activeWorkspaceIdRef = useRef(workspaceId);
	activeWorkspaceIdRef.current = workspaceId;
	const [rows, setRows] = useState<GatewayKeyRow[]>([]);
	const [name, setName] = useState('');
	const [expiresAt, setExpiresAt] = useState('');
	const [limit, setLimit] = useState('');
	const [limitReset, setLimitReset] = useState<'lifetime' | 'daily' | 'weekly' | 'monthly'>('lifetime');
	const [secret, setSecret] = useState('');
	const [secretKeyId, setSecretKeyId] = useState('');
	const [copied, setCopied] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState('');
	const [isMutating, startMutation] = useTransition();

	const load = useCallback(async (signal?: AbortSignal) => {
		if (!workspaceId) {
			setRows([]);
			setIsLoading(false);
			return;
		}
		setIsLoading(true);
		try {
			const response = await fetch('/api/user/gateway-keys', { cache: 'no-store', signal });
			const result = await readPortalJson<GatewayKeyRow[]>(response);
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
		setSecret('');
		setSecretKeyId('');
		setCopied(false);
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const create = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!workspaceId || isMutating) return;
		setError('');
		setSecret('');
		setSecretKeyId('');
		setCopied(false);
		startMutation(async () => {
			try {
				const normalizedLimit = limit.trim();
				const numericLimit = normalizedLimit === '' ? null : Number(normalizedLimit);
				if (numericLimit !== null && (!Number.isFinite(numericLimit) || numericLimit < 0)) {
					setError(t('limitInvalid'));
					return;
				}
				let canonicalExpiresAt: string | null = null;
				if (expiresAt) {
					const milliseconds = Date.parse(expiresAt);
					if (!Number.isFinite(milliseconds) || milliseconds <= Date.now()) {
						setError(t('expiryInvalid'));
						return;
					}
					canonicalExpiresAt = new Date(milliseconds).toISOString();
				}
				const response = await fetch('/api/user/gateway-keys', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						name: name.trim() || undefined,
						expires_at: canonicalExpiresAt,
						limit: numericLimit,
						limit_reset: limitReset === 'lifetime' ? null : limitReset,
					}),
				});
				const result = await readPortalJson<CreatedGatewayKey>(response);
				if (!response.ok || !result?.success || !result.data?.key) {
					setError(result?.message ?? t('createFailed'));
					return;
				}
				if (result.data.workspace_id !== activeWorkspaceIdRef.current) return;
				setSecret(result.data.key);
				setSecretKeyId(result.data.key_id);
				setName('');
				setExpiresAt('');
				setLimit('');
				setLimitReset('lifetime');
				await load();
			} catch {
				setError(t('createFailed'));
			}
		});
	};

	const revoke = (row: GatewayKeyRow) => {
		if (row.workspaceId !== workspaceId || isMutating || !window.confirm(t('confirmRevoke', { name: row.name ?? row.key }))) return;
		setError('');
		startMutation(async () => {
			try {
				const response = await fetch(`/api/user/gateway-keys/${encodeURIComponent(row.id)}`, {
					method: 'DELETE',
				});
				if (!response.ok) {
					const result = await readPortalJson<never>(response);
					setError(result?.message ?? t('revokeFailed'));
					return;
				}
				if (row.id === secretKeyId) {
					setSecret('');
					setSecretKeyId('');
					setCopied(false);
				}
				await load();
			} catch {
				setError(t('revokeFailed'));
			}
		});
	};

	const copySecret = async () => {
		try {
			await navigator.clipboard.writeText(secret);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};

	return (
		<section className="console-panel space-y-5 rounded-xl border p-5" style={{ borderColor: 'var(--console-border)' }}>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h1 className="text-xl font-semibold">{t('title')}</h1>
					<p className="console-muted mt-1 text-sm">{t('subtitle')}</p>
				</div>
				<div className="console-badge self-start rounded-full px-2.5 py-1 text-xs">
					{t('workspaceScope', { name: workspaceName || workspaceId })}
				</div>
			</div>

			<form onSubmit={create} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto]">
				<label className="space-y-1">
					<span className="console-muted text-xs">{t('name')}</span>
					<input
						value={name}
						onChange={(event) => setName(event.target.value.slice(0, 128))}
						placeholder={t('namePlaceholder')}
						className="console-input w-full rounded-lg border px-3 py-2 text-sm"
						maxLength={128}
					/>
				</label>
				<label className="space-y-1">
					<span className="console-muted text-xs">{t('expiresAt')}</span>
					<input
						type="datetime-local"
						value={expiresAt}
						onChange={(event) => setExpiresAt(event.target.value)}
						className="console-input w-full rounded-lg border px-3 py-2 text-sm"
					/>
				</label>
				<label className="space-y-1">
					<span className="console-muted text-xs">{t('limit')}</span>
					<input
						type="number"
						min="0"
						step="0.000001"
						value={limit}
						onChange={(event) => setLimit(event.target.value)}
						placeholder={t('limitPlaceholder')}
						className="console-input w-full rounded-lg border px-3 py-2 text-sm"
					/>
				</label>
				<label className="space-y-1">
					<span className="console-muted text-xs">{t('limitReset')}</span>
					<select
						value={limitReset}
						onChange={(event) => setLimitReset(event.target.value as typeof limitReset)}
						className="console-input w-full rounded-lg border px-3 py-2 text-sm"
					>
						<option value="lifetime">{t('resetLifetime')}</option>
						<option value="daily">{t('resetDaily')}</option>
						<option value="weekly">{t('resetWeekly')}</option>
						<option value="monthly">{t('resetMonthly')}</option>
					</select>
				</label>
				<button
					type="submit"
					disabled={!workspaceId || isSwitching || isMutating}
					className="self-end rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{isMutating ? t('creating') : t('create')}
				</button>
			</form>

			{secret && (
				<div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm">
					<div className="font-medium text-amber-600">{t('secretNotice')}</div>
					<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
						<code className="min-w-0 flex-1 break-all rounded bg-black/10 px-2 py-1.5 text-xs">{secret}</code>
						<button type="button" onClick={() => void copySecret()} className="rounded-md border px-3 py-1.5 text-xs">
							{copied ? t('copied') : t('copy')}
						</button>
					</div>
				</div>
			)}

			{error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">{error}</div>}

			<div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--console-border)' }}>
				{isLoading ? (
					<div className="console-muted px-4 py-8 text-center text-sm">{t('loading')}</div>
				) : rows.length === 0 ? (
					<div className="console-muted px-4 py-8 text-center text-sm">{t('empty')}</div>
				) : (
					<table className="w-full min-w-[900px] text-sm">
						<thead>
							<tr className="border-b text-left text-xs" style={{ borderColor: 'var(--console-border)' }}>
								<th className="px-4 py-2.5">{t('key')}</th>
								<th className="px-4 py-2.5">{t('status')}</th>
								<th className="px-4 py-2.5">{t('limitColumn')}</th>
								<th className="px-4 py-2.5">{t('lastUsed')}</th>
								<th className="px-4 py-2.5">{t('expires')}</th>
								<th className="px-4 py-2.5">{t('createdAt')}</th>
								<th className="px-4 py-2.5 text-right">{t('actions')}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.id} className="border-b last:border-0" style={{ borderColor: 'var(--console-border)' }}>
									<td className="px-4 py-3"><div className="font-medium">{row.name || t('unnamed')}</div><code className="console-muted text-xs">{row.key}</code></td>
									<td className="px-4 py-3"><span className="console-badge rounded-full px-2 py-0.5 text-xs">{row.status}</span></td>
									<td className="console-muted px-4 py-3 text-xs">
										{row.limit === null
											? t('unlimited')
											: t('limitValue', {
												limit: row.limit.toLocaleString(undefined, { maximumFractionDigits: 6 }),
												reset: t(resetTranslationKey(row.limitReset)),
											})}
									</td>
									<td className="console-muted px-4 py-3 text-xs">{row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : t('neverUsed')}</td>
									<td className="console-muted px-4 py-3 text-xs">{row.expiresAt ? new Date(row.expiresAt).toLocaleString() : t('neverExpires')}</td>
									<td className="console-muted px-4 py-3 text-xs">{new Date(row.createdAt).toLocaleString()}</td>
									<td className="px-4 py-3 text-right">
										{row.status === 'active' && <button type="button" disabled={isMutating} onClick={() => revoke(row)} className="rounded-md border border-red-500/30 px-2.5 py-1 text-xs text-red-500 disabled:opacity-50">{t('revoke')}</button>}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</section>
	);
}
