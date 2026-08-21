'use client';

/**
 * 共享密钥池治理：全部卖家上架的 key（脱敏）、调 seller_priority/weight、停用/删除。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { readApiJson } from '@/lib/api-json';

type SharedKeyRow = {
	id: string;
	sellerEmail: string;
	channelType: string;
	label: string | null;
	apiKeyMasked: string;
	keyFingerprint: string;
	status: string;
	sellerPriority: number;
	weight: number;
	inputPrice: number;
	outputPrice: number;
	servedInputTokens: number;
	servedOutputTokens: number;
	earnedTotal: number;
	failureReason: string | null;
	createdAt: string;
};

const STATUS_STYLES: Record<string, string> = {
	validating: 'bg-yellow-50 text-yellow-700',
	active: 'bg-green-50 text-green-700',
	paused: 'bg-gray-100 text-gray-600',
	invalid: 'bg-red-50 text-red-700',
	disabled: 'bg-gray-100 text-gray-500',
};

export default function AdminSharedKeysPage() {
	const t = useTranslations('sharedKeysPage');
	const tCommon = useTranslations('common');
	const [rows, setRows] = useState<SharedKeyRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [statusFilter, setStatusFilter] = useState('');

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const url = statusFilter ? `/api/admin/shared-keys?status=${encodeURIComponent(statusFilter)}` : '/api/admin/shared-keys';
			const response = await fetch(url, { cache: 'no-store' });
			const data = await readApiJson<SharedKeyRow[]>(response);
			if (!data.success) {
				setError(data.message ?? t('loadFailed'));
				setRows([]);
			} else {
				setRows(data.data ?? []);
				setError('');
			}
		} catch {
			setError(t('loadFailed'));
		} finally {
			setLoading(false);
		}
	}, [statusFilter, t]);

	useEffect(() => {
		void load();
	}, [load]);

	const patchKey = async (id: string, patch: Record<string, unknown>) => {
		const response = await fetch(`/api/admin/shared-keys/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch),
		});
		const data = await readApiJson<unknown>(response);
		if (!data.success) {
			setError(data.message ?? t('updateFailed'));
			return;
		}
		await load();
	};

	const removeKey = async (id: string) => {
		if (!window.confirm(t('confirmDelete'))) return;
		const response = await fetch(`/api/admin/shared-keys/${id}`, { method: 'DELETE' });
		const data = await readApiJson<unknown>(response);
		if (!data.success) {
			setError(data.message ?? t('updateFailed'));
			return;
		}
		await load();
	};

	return (
		<div className="p-6">
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="text-2xl font-bold text-gray-800">{t('title')}</h1>
					<p className="mt-1 text-sm text-gray-500">{t('subtitle')}</p>
				</div>
				<select
					value={statusFilter}
					onChange={(event) => setStatusFilter(event.target.value)}
					className="rounded-md border border-gray-300 px-3 py-2 text-sm"
				>
					<option value="">{t('filterAll')}</option>
					<option value="active">{t('filterActive')}</option>
					<option value="validating">{t('filterValidating')}</option>
					<option value="paused">{t('filterPaused')}</option>
					<option value="invalid">{t('filterInvalid')}</option>
					<option value="disabled">{t('filterDisabled')}</option>
				</select>
			</div>

			{error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>}

			<div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
				{loading ? (
					<div className="px-4 py-10 text-center text-sm text-gray-500">{tCommon('loading')}</div>
				) : rows.length === 0 ? (
					<div className="px-4 py-10 text-center text-sm text-gray-500">{t('empty')}</div>
				) : (
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-gray-100 text-left text-xs text-gray-500">
								<th className="px-4 py-2">{t('seller')}</th>
								<th className="px-4 py-2">{t('channel')}</th>
								<th className="px-4 py-2">{t('key')}</th>
								<th className="px-4 py-2">{t('status')}</th>
								<th className="px-4 py-2">{t('pricing')}</th>
								<th className="px-4 py-2">{t('priority')}</th>
								<th className="px-4 py-2">{t('weight')}</th>
								<th className="px-4 py-2">{t('usage')}</th>
								<th className="px-4 py-2">{t('actions')}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.id} className="border-b border-gray-50 align-top last:border-0">
									<td className="px-4 py-3 text-xs text-gray-600">{row.sellerEmail}</td>
									<td className="px-4 py-3">
										<div className="font-medium text-gray-700">{row.channelType}</div>
										{row.label && <div className="text-xs text-gray-400">{row.label}</div>}
									</td>
									<td className="px-4 py-3 font-mono text-xs text-gray-500">{row.apiKeyMasked}</td>
									<td className="px-4 py-3">
										<span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[row.status] ?? 'bg-gray-100 text-gray-600'}`}>
											{row.status}
										</span>
										{row.failureReason && <div className="mt-1 max-w-48 text-[11px] text-red-400">{row.failureReason}</div>}
									</td>
									<td className="px-4 py-3 text-xs text-gray-600">
										{t('priceCell', { input: row.inputPrice, output: row.outputPrice })}
									</td>
									<td className="px-4 py-3">
										<input
											type="number"
											defaultValue={row.sellerPriority}
											onBlur={(event) => {
												const value = Number(event.target.value);
												if (Number.isInteger(value) && value !== row.sellerPriority) {
													void patchKey(row.id, { sellerPriority: value });
												}
											}}
											className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
										/>
									</td>
									<td className="px-4 py-3">
										<input
											type="number"
											min="1"
											max="100"
											defaultValue={row.weight}
											onBlur={(event) => {
												const value = Number(event.target.value);
												if (Number.isInteger(value) && value >= 1 && value <= 100 && value !== row.weight) {
													void patchKey(row.id, { weight: value });
												}
											}}
											className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
										/>
									</td>
									<td className="px-4 py-3 text-xs text-gray-600">
										<div>{(row.servedInputTokens + row.servedOutputTokens).toLocaleString()} tokens</div>
										<div className="text-gray-400">${row.earnedTotal.toFixed(4)}</div>
									</td>
									<td className="px-4 py-3">
										<div className="flex flex-wrap gap-2 text-xs">
											{row.status !== 'disabled' ? (
												<button
													type="button"
													onClick={() => void patchKey(row.id, { status: 'disabled' })}
													className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-50"
												>
													{t('disable')}
												</button>
											) : (
												<button
													type="button"
													onClick={() => void patchKey(row.id, { status: 'active' })}
													className="rounded border border-cyan-300 px-2 py-1 text-cyan-700 hover:bg-cyan-50"
												>
													{t('enable')}
												</button>
											)}
											<button
												type="button"
												onClick={() => void removeKey(row.id)}
												className="rounded border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"
											>
												{t('delete')}
											</button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
