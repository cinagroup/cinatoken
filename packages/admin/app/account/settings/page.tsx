'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { readPortalJson } from '@/lib/portal-fetch';

type GatewayKeyRow = {
  id: string;
  key: string;
  name: string | null;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
};

type WalletInfo = {
  walletAddress: string | null;
  walletMasked: string | null;
};

export default function AccountSettingsPage() {
  const t = useTranslations('portal');
  const [keys, setKeys] = useState<GatewayKeyRow[]>([]);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [keysRes, walletRes] = await Promise.all([
		fetch('/api/user/gateway-keys', { cache: 'no-store' }),
        fetch('/api/user/wallet', { cache: 'no-store' }),
      ]);
      const keysData = await readPortalJson<GatewayKeyRow[]>(keysRes);
      const walletData = await readPortalJson<WalletInfo>(walletRes);
      if (keysData?.success) setKeys(keysData.data ?? []);
      if (walletData?.success) setWallet(walletData.data ?? null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createKey = async () => {
	const response = await fetch('/api/user/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newKeyName || null }),
    });
    const data = await readPortalJson<{ key: string }>(response);
    if (!response.ok || !data?.success) {
      setMessage({ kind: 'err', text: data?.message ?? t('settings.keyCreateFailed') });
      return;
    }
    setCreatedKey(data.data?.key ?? null);
    setNewKeyName('');
    await load();
  };

  const revokeKey = async (id: string) => {
    if (!window.confirm(t('settings.confirmRevoke'))) return;
	const response = await fetch(`/api/user/gateway-keys/${id}`, { method: 'DELETE' });
    if (response.ok) await load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">{t('settings.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('settings.subtitle')}</p>
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

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm font-medium text-gray-700">{t('settings.gatewayKeys')}</div>
        <p className="mt-1 text-xs text-gray-500">{t('settings.gatewayKeysHint')}</p>
        <div className="mt-3 flex gap-2">
          <input
            value={newKeyName}
            onChange={(event) => setNewKeyName(event.target.value)}
            placeholder={t('settings.keyName')}
            className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void createKey()}
            className="rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
          >
            {t('settings.createKey')}
          </button>
        </div>
        {createdKey && (
          <div className="mt-3 rounded-md border border-cyan-200 bg-cyan-50 p-3">
            <div className="text-xs text-cyan-700">{t('settings.keyOnce')}</div>
            <div className="mt-1 break-all font-mono text-sm text-cyan-900">{createdKey}</div>
          </div>
        )}
        {isLoading ? (
          <div className="py-6 text-center text-sm text-gray-500">{t('common.loading')}</div>
        ) : keys.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500">{t('settings.noKeys')}</div>
        ) : (
          <ul className="mt-4 divide-y divide-gray-50">
            {keys.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-gray-700">{key.key}</span>
                  {key.name && <span className="ml-2 text-xs text-gray-400">{key.name}</span>}
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span
                    className={`rounded-full px-2 py-0.5 ${
                      key.status === 'active' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {key.status}
                  </span>
                  {key.status === 'active' && (
                    <button
                      type="button"
                      onClick={() => void revokeKey(key.id)}
                      className="rounded border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"
                    >
                      {t('settings.revoke')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm font-medium text-gray-700">{t('settings.walletSection')}</div>
        <p className="mt-1 text-xs text-gray-500">
          {t('settings.walletValue', { wallet: wallet?.walletMasked ?? t('settings.walletNone') })}
        </p>
        <a href="/account/withdraw" className="mt-2 inline-block text-sm text-cyan-600 hover:underline">
          {t('nav.withdraw')} →
        </a>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm font-medium text-gray-700">{t('settings.profileSection')}</div>
        <p className="mt-1 text-xs text-gray-500">{t('settings.profileHint')}</p>
        <a
          href="https://accounts.cinaseek.ai"
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-sm text-cyan-600 hover:underline"
        >
          CinaAuth {t('settings.accountCenter')} ↗
        </a>
      </div>
    </div>
  );
}
