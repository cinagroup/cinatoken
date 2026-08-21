'use client';

/**
 * 根级鉴权壳：未登录时进入 CinaAuth；已登录则渲染 `Sidebar` + 子页面。
 * 本地会话依赖 `/api/auth/check`，管理权限由服务端向 CinaAuth 实时复核。
 */
import { useState, useEffect, useCallback, ReactNode } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import BrandExternalLinks from '@/components/layout/BrandExternalLinks';
import LocaleSwitcher from '@/components/layout/LocaleSwitcher';
import { BusinessTimezoneProvider } from '@/components/BusinessTimezoneProvider';
import { ADMIN_SESSION_EXPIRED_EVENT_NAME } from '@/lib/admin-session-events';
import { readJson } from '@/lib/api-json';
import Sidebar from './Sidebar';

interface Props {
  children: ReactNode;
}

export default function AuthWrapper({ children }: Props) {
  const pathname = usePathname();
  // 门户分区自带独立会话（user_session）与登录界面，不走管理台鉴权
  const isPublicHome = pathname === '/' || pathname.startsWith('/account');
  const t = useTranslations('auth');
  const tBrand = useTranslations('brand');
  const tCommon = useTranslations('common');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loginError, setLoginError] = useState('');

  const checkAuth = useCallback(async () => {
    if (isPublicHome) {
      setIsLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/auth/check');
      const data = await readJson<{ authenticated: boolean }>(response);
      setIsAuthenticated(data.authenticated);
    } catch (error) {
      console.error('Auth check error:', error);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, [isPublicHome]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
		const authError = new URLSearchParams(window.location.search).get('auth_error');
		if (authError) setLoginError(t('loginError'));
	}, [t]);

  useEffect(() => {
    const onSessionExpired = () => {
      void fetch('/api/auth/logout', { method: 'POST' });
      setIsAuthenticated(false);
      setIsLoading(false);
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, onSessionExpired);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, onSessionExpired);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        checkAuth();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [checkAuth]);

  if (isPublicHome) {
    return <>{children}</>;
  }

  // Loading state - full screen
  if (isLoading && !isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-gray-600">{tCommon('loading')}</div>
      </div>
    );
  }

  // Not authenticated - show login page (no sidebar)
  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
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
                  {tBrand('loginHeading')}
                </h1>
                <p className="mt-1 text-xs text-gray-500">{tBrand('operatorConsole')}</p>
              </div>
            </div>
            <div className="self-end sm:self-auto">
              <LocaleSwitcher variant="login" />
            </div>
          </div>
		  <p className="mb-5 text-sm leading-6 text-gray-600">{t('cinaAuthDescription')}</p>
			{loginError && (
			  <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
				{loginError}
			  </div>
			)}
		  <div className="space-y-3">
			<a
			  href="/api/auth/cinaauth/login?callbackURL=%2Fdashboard"
			  className="flex w-full items-center justify-center rounded-md bg-cyan-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
			>
			  {t('continueWithCinaAuth')}
			</a>
			<a
			  href="/api/auth/cinaauth/register?callbackURL=%2Fdashboard"
			  className="flex w-full items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2.5 font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
			>
			  {t('createAccount')}
			</a>
		  </div>
		  <p className="mt-4 text-xs leading-5 text-gray-500">{t('roleRequirement')}</p>
          <div className="mt-6 border-t border-gray-100 pt-4">
            <BrandExternalLinks variant="login" />
          </div>
        </div>
      </div>
    );
  }

  // Authenticated - show dashboard layout with sidebar
  return (
    <BusinessTimezoneProvider>
      <div className="flex h-dvh overflow-hidden">
        <Sidebar />
        <main className="flex-1 min-h-0 overflow-y-auto bg-gray-50">
          {children}
        </main>
      </div>
    </BusinessTimezoneProvider>
  );
}
