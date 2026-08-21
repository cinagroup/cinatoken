'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { readPortalJson } from '@/lib/portal-fetch';

type EarningRow = {
  id: string;
  requestLogId: string;
  sharedKeyId: string;
  inputTokens: number;
  outputTokens: number;
  grossAmount: number;
  platformFee: number;
  netAmount: number;
  currency: string;
  createdAt: string;
};

type EarningsSummary = {
  balance: number;
  lockedAmount: number;
  lifetimeEarned: number;
  lifetimeWithdrawn: number;
  contributionValue: number;
};

const PAGE_SIZE = 20;

export default function AccountEarningsPage() {
  const t = useTranslations('portal');
  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [rows, setRows] = useState<EarningRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async (targetPage: number) => {
    try {
      const [summaryRes, listRes] = await Promise.all([
        fetch('/api/user/earnings/summary', { cache: 'no-store' }),
        fetch(`/api/user/earnings?page=${targetPage}&pageSize=${PAGE_SIZE}`, { cache: 'no-store' }),
      ]);
      const summaryData = await readPortalJson<EarningsSummary>(summaryRes);
      const listData = await readPortalJson<EarningRow[]>(listRes);
      if (summaryData?.success) setSummary(summaryData.data ?? null);
      if (listData?.success) {
        setRows(listData.data ?? []);
        setTotal(listData.total ?? 0);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page);
  }, [load, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">{t('earnings.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('earnings.subtitle')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: t('overview.balance'), value: `$${(summary?.balance ?? 0).toFixed(4)}` },
          { label: t('overview.lockedShort'), value: `$${(summary?.lockedAmount ?? 0).toFixed(4)}` },
          { label: t('overview.lifetimeEarned'), value: `$${(summary?.lifetimeEarned ?? 0).toFixed(4)}` },
          { label: t('overview.contribution'), value: `$${(summary?.contributionValue ?? 0).toFixed(4)}` },
        ].map((card) => (
          <div key={card.label} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs text-gray-500">{card.label}</div>
            <div className="mt-1 text-xl font-semibold text-gray-800">{card.value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        {isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500">{t('common.loading')}</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500">{t('earnings.empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                  <th className="px-4 py-2">{t('earnings.time')}</th>
                  <th className="px-4 py-2">{t('earnings.tokens')}</th>
                  <th className="px-4 py-2">{t('earnings.gross')}</th>
                  <th className="px-4 py-2">{t('earnings.fee')}</th>
                  <th className="px-4 py-2">{t('earnings.net')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-4 py-2 text-xs text-gray-500">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600">
                      {t('keys.tokensCell', {
                        input: (row.inputTokens ?? 0).toLocaleString(),
                        output: (row.outputTokens ?? 0).toLocaleString(),
                      })}
                    </td>
                    <td className="px-4 py-2 text-gray-700">${(row.grossAmount ?? 0).toFixed(6)}</td>
                    <td className="px-4 py-2 text-gray-500">${(row.platformFee ?? 0).toFixed(6)}</td>
                    <td className="px-4 py-2 font-medium text-green-700">${(row.netAmount ?? 0).toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm">
              <span className="text-xs text-gray-500">{t('earnings.totalEntries', { total })}</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                  className="rounded border border-gray-300 px-3 py-1 text-gray-600 disabled:opacity-40"
                >
                  {t('common.prevPage')}
                </button>
                <span className="px-2 py-1 text-gray-500">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((prev) => prev + 1)}
                  className="rounded border border-gray-300 px-3 py-1 text-gray-600 disabled:opacity-40"
                >
                  {t('common.nextPage')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
