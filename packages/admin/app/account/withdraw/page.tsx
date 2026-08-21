'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { readPortalJson } from '@/lib/portal-fetch';

type EarningsSummary = {
  balance: number;
  lockedAmount: number;
};

type WithdrawalRow = {
  id: string;
  amount: number;
  fee: number;
  netAmount: number;
  walletAddress: string;
  status: string;
  tokenAmount: number | null;
  txHash: string | null;
  failureReason: string | null;
  createdAt: string;
  confirmedAt: string | null;
};

const EXPLORER = 'https://sepolia.basescan.org/tx/';

export default function AccountWithdrawPage() {
  const t = useTranslations('portal');
  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [wallet, setWallet] = useState<{ walletAddress: string | null } | null>(null);
  const [rows, setRows] = useState<WithdrawalRow[]>([]);
  const [amount, setAmount] = useState('');
  const [walletInput, setWalletInput] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [summaryRes, walletRes, listRes] = await Promise.all([
        fetch('/api/user/earnings/summary', { cache: 'no-store' }),
        fetch('/api/user/wallet', { cache: 'no-store' }),
        fetch('/api/user/withdrawals?page=1&pageSize=50', { cache: 'no-store' }),
      ]);
      const summaryData = await readPortalJson<EarningsSummary>(summaryRes);
      const walletData = await readPortalJson<{ walletAddress: string | null }>(walletRes);
      const listData = await readPortalJson<WithdrawalRow[]>(listRes);
      if (summaryData?.success) setSummary(summaryData.data ?? null);
      if (walletData?.success) {
        setWallet(walletData.data ?? null);
        setWalletInput(walletData.data?.walletAddress ?? '');
      }
      if (listData?.success) setRows(listData.data ?? []);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const saveWallet = async () => {
    const response = await fetch('/api/user/wallet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletAddress: walletInput.trim() }),
    });
    const data = await readPortalJson<unknown>(response);
    if (!response.ok || !data?.success) {
      setMessage({ kind: 'err', text: data?.message ?? t('withdraw.walletSaveFailed') });
      return;
    }
    setMessage({ kind: 'ok', text: t('withdraw.walletSaved') });
    await load();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch('/api/user/withdrawals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: Number(amount) }),
      });
      const data = await readPortalJson<WithdrawalRow>(response);
      if (!response.ok || !data?.success) {
        setMessage({ kind: 'err', text: data?.message ?? t('withdraw.submitFailed') });
        return;
      }
      setMessage({ kind: 'ok', text: t('withdraw.submitted') });
      setAmount('');
      await load();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">{t('withdraw.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('withdraw.subtitle')}</p>
      </div>

      {message && (
        <div
          className={`rounded-md border p-3 text-sm ${
            message.kind === 'ok'
              ? 'border-green-200 bg-green-50 text-green-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
          <div>
            <div className="text-xs text-gray-500">{t('overview.balance')}</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">
              ${(summary?.balance ?? 0).toFixed(4)}
              {summary?.lockedAmount ? (
                <span className="ml-2 text-sm font-normal text-gray-400">
                  {t('overview.locked', { amount: (summary.lockedAmount ?? 0).toFixed(2) })}
                </span>
              ) : null}
            </div>
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-gray-500">{t('withdraw.walletLabel')}</span>
            <div className="flex gap-2">
              <input
                value={walletInput}
                onChange={(event) => setWalletInput(event.target.value)}
                placeholder="0x…"
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => void saveWallet()}
                className="whitespace-nowrap rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                {t('withdraw.saveWallet')}
              </button>
            </div>
            <span className="text-[11px] text-gray-400">{t('withdraw.walletHint')}</span>
          </label>
          <form onSubmit={submit} className="space-y-3 border-t border-gray-100 pt-4">
            <label className="block space-y-1">
              <span className="text-xs text-gray-500">{t('withdraw.amountLabel')}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                required
              />
            </label>
            <button
              type="submit"
              disabled={isSubmitting || !wallet?.walletAddress}
              className="rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
            >
              {isSubmitting ? t('common.submitting') : t('withdraw.submit')}
            </button>
            {!wallet?.walletAddress && (
              <div className="text-xs text-amber-600">{t('withdraw.needWallet')}</div>
            )}
          </form>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-4 py-3 text-sm font-medium text-gray-700">
            {t('withdraw.history')}
          </div>
          {isLoading ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500">{t('common.loading')}</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500">{t('withdraw.empty')}</div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {rows.map((row) => (
                <li key={row.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-gray-800">${(row.amount ?? 0).toFixed(2)}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        row.status === 'confirmed'
                          ? 'bg-green-50 text-green-700'
                          : row.status === 'failed'
                            ? 'bg-red-50 text-red-700'
                            : 'bg-yellow-50 text-yellow-700'
                      }`}
                    >
                      {t(`withdraw.status_${row.status}`)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
                    <span>{new Date(row.createdAt).toLocaleString()}</span>
                    {row.tokenAmount != null && (
                      <span>
                        {t('withdraw.tokenAmount', { amount: row.tokenAmount.toFixed(2) })}
                      </span>
                    )}
                    {row.txHash && (
                      <a
                        href={`${EXPLORER}${row.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-600 hover:underline"
                      >
                        {t('withdraw.viewTx')} ↗
                      </a>
                    )}
                  </div>
                  {row.failureReason && (
                    <div className="mt-1 text-xs text-red-400">{row.failureReason}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
