'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { readPortalJson } from '@/lib/portal-fetch';

type EarningsSummary = {
  balance: number;
  lockedAmount: number;
  lifetimeEarned: number;
  lifetimeWithdrawn: number;
  contributionValue: number;
  walletAddress: string | null;
  highestBadgeTier: number;
};

type SharedKeyRow = {
  id: string;
  channelType: string;
  status: string;
  servedInputTokens: number;
  servedOutputTokens: number;
  earnedTotal: number;
};

type Tier = {
  badgeTokenId: number;
  tierName: string;
  threshold: number;
  eligible: boolean;
  minted: boolean;
  progress: number;
};

export default function AccountOverviewPage() {
  const t = useTranslations('portal');
  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [keys, setKeys] = useState<SharedKeyRow[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [earningsRes, keysRes, tiersRes] = await Promise.all([
        fetch('/api/user/earnings/summary', { cache: 'no-store' }),
        fetch('/api/user/shared-keys', { cache: 'no-store' }),
        fetch('/api/user/nft/tiers', { cache: 'no-store' }),
      ]);
      const earningsData = await readPortalJson<EarningsSummary>(earningsRes);
      const keysData = await readPortalJson<SharedKeyRow[]>(keysRes);
      const tiersData = await readPortalJson<{ tiers: Tier[] }>(tiersRes);
      if (earningsData?.success) setSummary(earningsData.data ?? null);
      if (keysData?.success) setKeys(keysData.data ?? []);
      if (tiersData?.success) setTiers(tiersData.data?.tiers ?? []);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (isLoading) {
    return <div className="py-12 text-center text-gray-500">{t('common.loading')}</div>;
  }

  const activeKeys = keys.filter((key) => key.status === 'active').length;
  const nextTier = tiers.find((tier) => !tier.minted && !tier.eligible) ?? null;
  const mintableTiers = tiers.filter((tier) => tier.eligible && !tier.minted).length;

  const cards = [
    { label: t('overview.balance'), value: `$${(summary?.balance ?? 0).toFixed(2)}`, hint: summary?.lockedAmount ? t('overview.locked', { amount: (summary.lockedAmount ?? 0).toFixed(2) }) : '' },
    { label: t('overview.contribution'), value: `$${(summary?.contributionValue ?? 0).toFixed(2)}`, hint: nextTier ? t('overview.nextTier', { tier: nextTier.tierName, threshold: nextTier.threshold, progress: Math.floor((nextTier.progress ?? 0) * 100) }) : '' },
    { label: t('overview.activeKeys'), value: String(activeKeys), hint: t('overview.totalKeys', { count: keys.length }) },
    { label: t('overview.lifetimeEarned'), value: `$${(summary?.lifetimeEarned ?? 0).toFixed(2)}`, hint: t('overview.withdrawn', { amount: (summary?.lifetimeWithdrawn ?? 0).toFixed(2) }) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">{t('overview.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('overview.subtitle')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs text-gray-500">{card.label}</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">{card.value}</div>
            {card.hint && <div className="mt-1 text-xs text-gray-400">{card.hint}</div>}
          </div>
        ))}
      </div>

      {mintableTiers > 0 && (
        <Link
          href="/account/nft"
          className="block rounded-lg border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-800 hover:bg-cyan-100"
        >
          {t('overview.mintableBadge', { count: mintableTiers })} → {t('nav.nft')}
        </Link>
      )}

      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3 text-sm font-medium text-gray-700">
          {t('overview.recentKeys')}
        </div>
        {keys.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500">
            {t('overview.noKeys')}{' '}
            <Link href="/account/keys" className="text-cyan-600 hover:underline">
              {t('nav.keys')} →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                  <th className="px-4 py-2">{t('keys.channel')}</th>
                  <th className="px-4 py-2">{t('keys.status')}</th>
                  <th className="px-4 py-2">{t('overview.servedTokens')}</th>
                  <th className="px-4 py-2">{t('overview.earned')}</th>
                </tr>
              </thead>
              <tbody>
                {keys.slice(0, 5).map((key) => (
                  <tr key={key.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-4 py-2 font-medium text-gray-700">{key.channelType}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          key.status === 'active'
                            ? 'bg-green-50 text-green-700'
                            : key.status === 'invalid'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {t(`keys.status_${key.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {(
                        (key.servedInputTokens ?? 0) + (key.servedOutputTokens ?? 0)
                      ).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-gray-600">${(key.earnedTotal ?? 0).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
