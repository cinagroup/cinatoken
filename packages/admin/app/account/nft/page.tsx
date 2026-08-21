'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { readPortalJson } from '@/lib/portal-fetch';

type Tier = {
  badgeTokenId: number;
  tierName: string;
  threshold: number;
  eligible: boolean;
  minted: boolean;
  progress: number;
};

type MintRow = {
  id: string;
  badgeTokenId: number;
  tierName: string;
  walletAddress: string;
  status: string;
  txHash: string | null;
  valueSnapshot: number;
  createdAt: string;
};

const EXPLORER = 'https://sepolia.basescan.org/tx/';

export default function AccountNftPage() {
  const t = useTranslations('portal');
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [mints, setMints] = useState<MintRow[]>([]);
  const [contribution, setContribution] = useState(0);
  const [chainConfigured, setChainConfigured] = useState(true);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [minting, setMinting] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/user/nft/tiers', { cache: 'no-store' });
      const data = await readPortalJson<{ tiers: Tier[]; mints: MintRow[]; contributionValue: number; chainConfigured: boolean }>(response);
      if (data?.success) {
        setTiers(data.data?.tiers ?? []);
        setMints(data.data?.mints ?? []);
        setContribution(data.data?.contributionValue ?? 0);
        setChainConfigured(data.data?.chainConfigured ?? true);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const mint = async (badgeTokenId: number) => {
    setMinting(badgeTokenId);
    setMessage(null);
    try {
      const response = await fetch('/api/user/nft/mint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ badgeTokenId }),
      });
      const data = await readPortalJson<MintRow>(response);
      if (!response.ok || !data?.success) {
        setMessage({ kind: 'err', text: data?.message ?? t('nft.mintFailed') });
        return;
      }
      setMessage({ kind: 'ok', text: t('nft.mintSubmitted') });
      await load();
    } finally {
      setMinting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">{t('nft.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('nft.subtitle')}</p>
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

      {!chainConfigured && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          {t('nft.chainNotConfigured')}
        </div>
      )}

      {isLoading ? (
        <div className="py-12 text-center text-sm text-gray-500">{t('common.loading')}</div>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs text-gray-500">{t('overview.contribution')}</div>
            <div className="mt-1 text-3xl font-bold text-gray-800">${contribution.toFixed(2)}</div>
            <div className="mt-1 text-xs text-gray-400">{t('nft.contributionHint')}</div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {tiers.map((tier) => (
              <div
                key={tier.badgeTokenId}
                className={`rounded-lg border p-4 ${
                  tier.minted
                    ? 'border-cyan-200 bg-cyan-50'
                    : tier.eligible
                      ? 'border-green-200 bg-green-50'
                      : 'border-gray-200 bg-white'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-gray-800">{t(`nft.tier_${tier.tierName}`)}</span>
                  <span className="text-xs text-gray-400">#{tier.badgeTokenId}</span>
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  {t('nft.threshold', { threshold: tier.threshold })}
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full ${tier.minted || tier.eligible ? 'bg-cyan-500' : 'bg-gray-300'}`}
                    style={{ width: `${Math.min(100, Math.floor((tier.progress ?? 0) * 100))}%` }}
                  />
                </div>
                <div className="mt-3">
                  {tier.minted ? (
                    <span className="text-xs font-medium text-cyan-700">{t('nft.minted')}</span>
                  ) : tier.eligible ? (
                    <button
                      type="button"
                      disabled={minting === tier.badgeTokenId || !chainConfigured}
                      onClick={() => void mint(tier.badgeTokenId)}
                      className="w-full rounded-md bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
                    >
                      {minting === tier.badgeTokenId ? t('common.submitting') : t('nft.mint')}
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">
                      {t('nft.progress', { percent: Math.floor((tier.progress ?? 0) * 100) })}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-4 py-3 text-sm font-medium text-gray-700">
              {t('nft.history')}
            </div>
            {mints.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500">{t('nft.empty')}</div>
            ) : (
              <ul className="divide-y divide-gray-50">
                {mints.map((mint) => (
                  <li key={mint.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                    <div>
                      <span className="font-medium text-gray-800">{t(`nft.tier_${mint.tierName}`)}</span>
                      <span className="ml-2 text-xs text-gray-400">
                        #{mint.badgeTokenId} · {new Date(mint.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span
                        className={`rounded-full px-2 py-0.5 ${
                          mint.status === 'confirmed'
                            ? 'bg-green-50 text-green-700'
                            : mint.status === 'failed'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-yellow-50 text-yellow-700'
                        }`}
                      >
                        {t(`nft.status_${mint.status}`)}
                      </span>
                      {mint.txHash && (
                        <a
                          href={`${EXPLORER}${mint.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-cyan-600 hover:underline"
                        >
                          {t('withdraw.viewTx')} ↗
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
