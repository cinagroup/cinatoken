'use client';

/**
 * CinaBadge 铸造记录：全部位阶铸造与手动处理触发。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { readApiJson } from '@/lib/api-json';

type MintRow = {
	id: string;
	userId: string;
	badgeTokenId: number;
	tierName: string;
	walletAddress: string;
	status: string;
	txHash: string | null;
	chainId: number | null;
	valueSnapshot: number;
	failureReason: string | null;
	createdAt: string;
	confirmedAt: string | null;
};

const EXPLORER = 'https://sepolia.basescan.org/tx/';

const STATUS_STYLES: Record<string, string> = {
	pending: 'bg-yellow-50 text-yellow-700',
	submitted: 'bg-blue-50 text-blue-700',
	confirmed: 'bg-green-50 text-green-700',
	failed: 'bg-red-50 text-red-700',
};

export default function AdminNftMintsPage() {
	const t = useTranslations('nftMintsPage');
	const tCommon = useTranslations('common');
	const [rows, setRows] = useState<MintRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [statusFilter, setStatusFilter] = useState('');

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const url = statusFilter ? `/api/admin/nft-mints?status=${encodeURIComponent(statusFilter)}` : '/api/admin/nft-mints';
			const response = await fetch(url, { cache: 'no-store' });
			const data = await readApiJson<MintRow[]>(response);
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

	const processPending = async () => {
		setBusy(true);
		try {
			const response = await fetch('/api/admin/nft-mints/process', { method: 'POST' });
			const data = await readApiJson<{ processed: number; confirmed: number; failed: number }>(response);
			if (!data.success) setError(data.message ?? t('processFailed'));
			await load();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="p-6">
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="text-2xl font-bold text-gray-800">{t('title')}</h1>
					<p className="mt-1 text-sm text-gray-500">{t('subtitle')}</p>
				</div>
				<div className="flex items-center gap-2">
					<select
						value={statusFilter}
						onChange={(event) => setStatusFilter(event.target.value)}
						className="rounded-md border border-gray-300 px-3 py-2 text-sm"
					>
						<option value="">{t('filterAll')}</option>
						<option value="pending">pending</option>
						<option value="submitted">submitted</option>
						<option value="confirmed">confirmed</option>
						<option value="failed">failed</option>
					</select>
					<button
						type="button"
						disabled={busy}
						onClick={() => void processPending()}
						className="rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
					>
						{busy ? tCommon('loading') : t('processPending')}
					</button>
				</div>
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
								<th className="px-4 py-2">{t('time')}</th>
								<th className="px-4 py-2">{t('user')}</th>
								<th className="px-4 py-2">{t('tier')}</th>
								<th className="px-4 py-2">{t('wallet')}</th>
								<th className="px-4 py-2">{t('value')}</th>
								<th className="px-4 py-2">{t('status')}</th>
								<th className="px-4 py-2">{t('tx')}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.id} className="border-b border-gray-50 align-top last:border-0">
									<td className="px-4 py-3 text-xs text-gray-500">{new Date(row.createdAt).toLocaleString()}</td>
									<td className="px-4 py-3 font-mono text-xs text-gray-600">{row.userId.slice(0, 8)}…</td>
									<td className="px-4 py-3 text-gray-700">
										{row.tierName} <span className="text-xs text-gray-400">#{row.badgeTokenId}</span>
									</td>
									<td className="px-4 py-3 font-mono text-xs text-gray-500">{row.walletAddress}</td>
									<td className="px-4 py-3 text-gray-600">${row.valueSnapshot.toFixed(2)}</td>
									<td className="px-4 py-3">
										<span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[row.status] ?? 'bg-gray-100 text-gray-600'}`}>
											{row.status}
										</span>
										{row.failureReason && <div className="mt-1 max-w-48 text-[11px] text-red-400">{row.failureReason}</div>}
									</td>
									<td className="px-4 py-3 text-xs">
										{row.txHash ? (
											<a href={`${EXPLORER}${row.txHash}`} target="_blank" rel="noreferrer" className="text-cyan-600 hover:underline">
												{row.txHash.slice(0, 10)}… ↗
											</a>
										) : (
											'-'
										)}
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
