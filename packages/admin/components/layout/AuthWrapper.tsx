'use client';

/**
 * 根级鉴权壳：未登录时进入 CinaAuth；已登录则渲染 `Sidebar` + 子页面。
 * 本地会话依赖 `/api/auth/check`，管理权限由服务端向 CinaAuth 实时复核。
 */
import { useState, useEffect, useCallback, ReactNode } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import BrandExternalLinks from '@/components/layout/BrandExternalLinks';
import LocaleSwitcher from '@/components/layout/LocaleSwitcher';
import { BusinessTimezoneProvider } from '@/components/BusinessTimezoneProvider';
import { ADMIN_SESSION_EXPIRED_EVENT_NAME } from '@/lib/admin-session-events';
import { readJson } from '@/lib/api-json';
import { isPublicProductPath } from '@/lib/public-routes';
import Sidebar from './Sidebar';
import ConsoleThemeToggle from '@/components/unified/ConsoleThemeToggle';
import AdminMobileHeader from './AdminMobileHeader';

interface Props {
  children: ReactNode;
}

export default function AuthWrapper({ children }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  // 门户分区使用统一会话，但不要求管理员能力。
  const isPublicHome = isPublicProductPath(pathname);
  const t = useTranslations('auth');
  const tBrand = useTranslations('brand');
  const tCommon = useTranslations('common');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loginErrorCode, setLoginErrorCode] = useState('');

  const checkAuth = useCallback(async () => {
    if (isPublicHome) {
      setIsLoading(false);
      return;
    }

    try {
	  if (pathname === '/dashboard' || pathname.startsWith('/admin') || pathname.startsWith('/gateway')) {
        const accountResponse = await fetch('/api/user/me', { cache: 'no-store' });
        if (accountResponse.ok) {
          const account = await readJson<{ success: boolean; data?: { isAdmin: boolean } }>(accountResponse);
          if (account.data && !account.data.isAdmin) {
            router.replace('/account');
            return;
          }
        }
      }
      const response = await fetch('/api/auth/check');
      const data = await readJson<{ authenticated: boolean }>(response);
      setIsAuthenticated(data.authenticated);
    } catch (error) {
      console.error('Auth check error:', error);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, [isPublicHome, pathname, router]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

	useEffect(() => {
		const authError = new URLSearchParams(window.location.search).get('auth_error');
		if (authError) setLoginErrorCode(authError);
	}, []);

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
	  <div className="console-shell flex items-center justify-center h-screen bg-gray-50">
        <div className="text-gray-600">{tCommon('loading')}</div>
      </div>
    );
  }

  // Not authenticated - show login page (no sidebar)
  if (!isAuthenticated) {
    return (
	  <div className="console-shell flex items-center justify-center h-screen bg-gray-50 px-4">
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
			<div className="flex self-end items-center gap-2 sm:self-auto">
			  <ConsoleThemeToggle />
              <LocaleSwitcher variant="login" />
            </div>
          </div>
		  <p className="mb-5 text-sm leading-6 text-gray-600">{t('cinaAuthDescription')}</p>
			{loginErrorCode === 'admin_forbidden' ? (
			  <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
				<p className="font-medium">{t('adminForbidden')}</p>
				<p className="mt-1 text-xs leading-5 text-amber-800">{t('adminForbiddenHelp')}</p>
				<div className="mt-3 flex flex-col gap-2 sm:flex-row">
				  <a
					href="https://admin.cinaseek.ai"
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center justify-center rounded-md border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100"
				  >
					{t('manageCinaAuthRoles')}
				  </a>
				  <a
					href="/api/auth/cinaauth/login?intent=portal&callbackURL=%2Faccount"
					className="inline-flex items-center justify-center rounded-md px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100"
				  >
					{t('continueToUserCenter')}
				  </a>
				</div>
			  </div>
			) : loginErrorCode ? (
			  <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
				{t('loginError')}
			  </div>
			) : null}
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
	  <div className="console-shell flex min-h-dvh lg:h-dvh lg:overflow-hidden">
        <Sidebar />
		<div className="flex min-w-0 flex-1 flex-col">
		  <AdminMobileHeader />
		  <main id="main-content" className="min-h-0 flex-1 lg:overflow-y-auto" style={{ background: 'var(--console-bg)' }}>
			{children}
		  </main>
		</div>
      </div>
    </BusinessTimezoneProvider>
  );
}
