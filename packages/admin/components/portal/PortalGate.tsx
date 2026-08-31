'use client';

/**
 * 门户鉴权壳：`/account/*` 分区专用。
 * - 未登录（无统一会话）→ CinaAuth 门户登录卡（intent=portal，不要求管理员角色）；
 * - 已登录 → 门户导航 + 内容。
 * 会话依赖 `/api/user/me`（401 即未登录）。
 */
import { useCallback, useEffect, useRef, useState, useTransition, ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { WorkspaceContextProjection } from '@octafuse/core';
import { useTranslations } from 'next-intl';
import LocaleSwitcher from '@/components/layout/LocaleSwitcher';
import { readPortalJson } from '@/lib/portal-fetch';
import ConsoleThemeToggle from '@/components/unified/ConsoleThemeToggle';
import FrontendAttribution from '@/components/unified/FrontendAttribution';
import { PortalWorkspaceProvider } from '@/components/portal/PortalWorkspaceContext';
import PortalWorkspaceSwitcher from '@/components/portal/PortalWorkspaceSwitcher';
import {
  ArrowLeftStartOnRectangleIcon,
  BanknotesIcon,
  ChartBarSquareIcon,
  Cog6ToothIcon,
	ClockIcon,
  HomeIcon,
  KeyIcon,
	QueueListIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';

interface Props {
  children: ReactNode;
}

export type PortalMe = {
  userId: string;
  subject: string;
  email: string;
  isAdmin: boolean;
  capabilities: string[];
};

export default function PortalGate({ children }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations('portal');
  const tAuth = useTranslations('auth');
  const tCommon = useTranslations('common');
  const tBrand = useTranslations('brand');
  const [me, setMe] = useState<PortalMe | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loginError, setLoginError] = useState('');
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContextProjection | null>(null);
  const [workspaceError, setWorkspaceError] = useState<'load' | 'switch' | null>(null);
  const [isWorkspaceSwitching, startWorkspaceTransition] = useTransition();
  const sessionRequestEpoch = useRef(0);

  const checkSession = useCallback(async () => {
	const epoch = ++sessionRequestEpoch.current;
	const [sessionResult, workspaceResult] = await Promise.allSettled([
		fetch('/api/user/me', { cache: 'no-store' }),
		fetch('/api/user/workspaces', { cache: 'no-store' }),
	]);
	if (epoch !== sessionRequestEpoch.current) return;
	if (sessionResult.status !== 'fulfilled' || !sessionResult.value.ok) {
		setMe(null);
		setWorkspaceContext(null);
		setWorkspaceError(null);
		setIsLoading(false);
		return;
	}
	const sessionData = await readPortalJson<PortalMe>(sessionResult.value);
	if (epoch !== sessionRequestEpoch.current) return;
	setMe(sessionData?.data ?? null);
	if (workspaceResult.status === 'fulfilled' && workspaceResult.value.ok) {
		const workspaceData = await readPortalJson<WorkspaceContextProjection>(workspaceResult.value);
		if (epoch !== sessionRequestEpoch.current) return;
		setWorkspaceContext(workspaceData?.data ?? null);
		setWorkspaceError(workspaceData?.data ? null : 'load');
	} else {
		setWorkspaceContext(null);
		setWorkspaceError('load');
	}
	setIsLoading(false);
  }, []);

  useEffect(() => {
	const timer = window.setTimeout(() => void checkSession(), 0);
	return () => window.clearTimeout(timer);
  }, [checkSession]);

  useEffect(() => {
	const timer = window.setTimeout(() => {
		const authError = new URLSearchParams(window.location.search).get('auth_error');
		if (authError) setLoginError(tAuth('loginError'));
	}, 0);
	return () => window.clearTimeout(timer);
  }, [tAuth]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkSession();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [checkSession]);

  const logout = async () => {
	sessionRequestEpoch.current += 1;
    await fetch('/api/user/auth/logout', { method: 'POST' }).catch(() => undefined);
    setMe(null);
	setWorkspaceContext(null);
	setWorkspaceError(null);
  };

  const selectWorkspace = useCallback((workspaceId: string) => {
	if (!workspaceId || workspaceId === workspaceContext?.currentWorkspace.id) return;
	sessionRequestEpoch.current += 1;
	setWorkspaceError(null);
	startWorkspaceTransition(async () => {
		try {
			const response = await fetch('/api/user/workspaces/current', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspace_id: workspaceId }),
			});
			const result = await readPortalJson<WorkspaceContextProjection>(response);
			if (!response.ok || !result?.data) {
				setWorkspaceError('switch');
				return;
			}
			setWorkspaceContext(result.data);
			router.refresh();
		} catch {
			setWorkspaceError('switch');
		}
	});
  }, [router, workspaceContext?.currentWorkspace.id]);

  const navItems = [
    { href: '/account', label: t('nav.overview'), Icon: HomeIcon },
	{ href: '/account/activity', label: t('nav.activity'), Icon: ClockIcon },
    { href: '/account/keys', label: t('nav.keys'), Icon: KeyIcon },
	{ href: '/account/presets', label: t('nav.presets'), Icon: QueueListIcon },
	{ href: '/account/guardrails', label: t('nav.guardrails'), Icon: ShieldCheckIcon },
    { href: '/account/earnings', label: t('nav.earnings'), Icon: ChartBarSquareIcon },
    { href: '/account/withdraw', label: t('nav.withdraw'), Icon: BanknotesIcon },
    { href: '/account/nft', label: t('nav.nft'), Icon: SparklesIcon },
    { href: '/account/settings', label: t('nav.settings'), Icon: Cog6ToothIcon },
  ];

  if (isLoading) {
    return (
	  <div className="console-shell flex items-center justify-center h-screen bg-gray-50">
        <div className="text-gray-600">{tCommon('loading')}</div>
      </div>
    );
  }

  if (!me) {
    return (
	  <div className="console-shell flex items-center justify-center min-h-screen bg-gray-50 px-4">
        <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <Image
                src="/brand/logo.png"
                alt={tBrand('logoAlt')}
                width={52}
                height={52}
                priority
                className="h-[52px] w-[52px] shrink-0 rounded-lg"
              />
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-bold leading-tight text-gray-800 sm:text-2xl">
                  {t('loginHeading')}
                </h1>
                <p className="mt-1 text-xs text-gray-500">{t('loginSubtitle')}</p>
              </div>
            </div>
			<div className="flex self-end items-center gap-2 sm:self-auto">
			  <ConsoleThemeToggle />
              <LocaleSwitcher variant="login" />
            </div>
          </div>
          <p className="mb-5 text-sm leading-6 text-gray-600">{t('loginDescription')}</p>
          {loginError && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
              {loginError}
            </div>
          )}
          <div className="space-y-3">
            <a
              href="/api/auth/cinaauth/login?intent=portal&callbackURL=%2Faccount"
              className="flex w-full items-center justify-center rounded-md bg-cyan-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
            >
              {tAuth('continueWithCinaAuth')}
            </a>
            <a
              href="/api/auth/cinaauth/register?intent=portal&callbackURL=%2Faccount"
              className="flex w-full items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2.5 font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
            >
              {tAuth('createAccount')}
            </a>
            <Link
              href="/"
              className="flex w-full items-center justify-center rounded-md px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              {t('backToHome')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <PortalWorkspaceProvider
	  context={workspaceContext}
	  error={workspaceError}
	  isSwitching={isWorkspaceSwitching}
	  selectWorkspace={selectWorkspace}
	>
    <div className="console-shell flex min-h-dvh">
      <aside className="console-panel sticky top-0 hidden h-dvh w-64 shrink-0 border-r lg:flex lg:flex-col">
        <div className="flex h-16 items-center gap-3 border-b px-4" style={{ borderColor: 'var(--console-border)' }}>
          <Image src="/brand/logo.png" alt={tBrand('logoAlt')} width={36} height={36} className="h-9 w-9 rounded-xl" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">CinaToken</div>
            <div className="console-muted truncate text-xs">{t('portalTitle')}</div>
          </div>
        </div>
		<PortalWorkspaceSwitcher />
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {navItems.map((item) => {
            const active = pathname === item.href || (item.href !== '/account' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} data-active={active} className="console-nav-link flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium">
                <item.Icon className="h-[18px] w-[18px]" />
                {item.label}
              </Link>
            );
          })}
          {me.isAdmin && (
            <Link href="/dashboard" className="console-nav-link mt-3 flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium" style={{ borderColor: 'var(--console-border)' }}>
              <ShieldCheckIcon className="h-[18px] w-[18px]" />
              {tBrand('operatorConsole')}
            </Link>
          )}
        </nav>
        <div className="space-y-3 border-t p-3" style={{ borderColor: 'var(--console-border)' }}>
          <div className="flex items-center justify-between gap-2">
            <ConsoleThemeToggle />
            <LocaleSwitcher variant="login" />
          </div>
          <button type="button" onClick={() => void logout()} className="console-nav-link flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm">
            <ArrowLeftStartOnRectangleIcon className="h-[18px] w-[18px]" />
            {tAuth('logout')}
          </button>
          <div className="console-muted"><FrontendAttribution compact /></div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="console-panel sticky top-0 z-30 border-b lg:hidden" style={{ borderColor: 'var(--console-border)' }}>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Image src="/brand/logo.png" alt={tBrand('logoAlt')} width={32} height={32} className="h-8 w-8 rounded-lg" />
              <div className="min-w-0"><div className="text-sm font-semibold">CinaToken</div><div className="console-muted truncate text-xs">{me.email}</div></div>
            </div>
            <ConsoleThemeToggle />
          </div>
		  <div className="border-t px-4 py-2.5" style={{ borderColor: 'var(--console-border)' }}>
			<PortalWorkspaceSwitcher compact />
		  </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
            {navItems.map((item) => {
              const active = pathname === item.href || (item.href !== '/account' && pathname.startsWith(item.href));
              return <Link key={item.href} href={item.href} data-active={active} className="console-nav-link whitespace-nowrap rounded-lg px-3 py-1.5 text-sm">{item.label}</Link>;
            })}
          </nav>
        </header>
        <main id="main-content" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
	</PortalWorkspaceProvider>
  );
}
