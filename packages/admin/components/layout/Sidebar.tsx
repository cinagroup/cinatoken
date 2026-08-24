'use client';

/**
 * 左侧导航：Dashboard、推理与路由、Tools、分析、系统集成、系统（含 Config 与 Logout）；底部外链与版本号。
 */
import Link from 'next/link';
import Image from 'next/image';
import BrandExternalLinks from '@/components/layout/BrandExternalLinks';
import LocaleSwitcher from '@/components/layout/LocaleSwitcher';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowLeftStartOnRectangleIcon,
  HomeIcon,
  KeyIcon,
  CpuChipIcon,
  GlobeAltIcon,
  ArrowsRightLeftIcon,
  BeakerIcon,
  PlayCircleIcon,
  DocumentChartBarIcon,
  ClipboardDocumentListIcon,
  ChartBarIcon,
  ServerStackIcon,
  UsersIcon,
  ShieldCheckIcon,
  Cog6ToothIcon,
  WrenchScrewdriverIcon,
  QueueListIcon,
  BanknotesIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { useState } from 'react';
import { ADMIN_NAV_GROUPS, type AdminNavNameKey } from '@/lib/admin-nav';
import { adminAppVersion } from '@/lib/app-version';
import ConsoleThemeToggle from '@/components/unified/ConsoleThemeToggle';
import FrontendAttribution from '@/components/unified/FrontendAttribution';

const NAV_ICONS: Record<AdminNavNameKey, React.ComponentType<{ className?: string }>> = {
  dashboard: HomeIcon,
  providers: GlobeAltIcon,
  models: CpuChipIcon,
  routes: ArrowsRightLeftIcon,
  playground: BeakerIcon,
  simulator: PlayCircleIcon,
  users: UsersIcon,
  apiKeys: KeyIcon,
  requestLogs: DocumentChartBarIcon,
  auditLogs: ClipboardDocumentListIcon,
  toolsConfig: WrenchScrewdriverIcon,
  toolInvocations: QueueListIcon,
  modelUsage: ChartBarIcon,
  providerUsage: ServerStackIcon,
  userUsage: UsersIcon,
  reliability: ShieldCheckIcon,
  adminApiKeys: KeyIcon,
  sharedKeys: ArrowsRightLeftIcon,
  withdrawals: BanknotesIcon,
  nftMints: SparklesIcon,
  config: Cog6ToothIcon,
};

export default function Sidebar({
  mobile = false,
  onNavigate,
}: {
  mobile?: boolean;
  onNavigate?: () => void;
} = {}) {
  const t = useTranslations('sidebar');
  const tBrand = useTranslations('brand');
  const tAuth = useTranslations('auth');
  const tPortalSettings = useTranslations('portal.settings');
  const pathname = usePathname();
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    if (isLoggingOut) return;

    setIsLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/');
      router.refresh();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <aside
      className={`console-panel h-dvh w-64 shrink-0 border-r ${mobile ? '' : 'sticky top-0 hidden lg:block'}`}
      style={{ borderColor: 'var(--console-border)' }}
    >
      <div className="flex h-full flex-col">
      {/* Logo / Brand + locale */}
      <div className="flex h-16 items-center justify-between gap-2 border-b px-4 leading-tight" style={{ borderColor: 'var(--console-border)' }}>
        <Link href="/dashboard" onClick={onNavigate} className="flex min-w-0 items-center gap-2.5 hover:opacity-90">
          <Image
            src="/brand/logo.png"
            alt={tBrand('logoAlt')}
            width={38}
            height={38}
            priority
            className="h-[38px] w-[38px] shrink-0 rounded-md"
          />
          <span className="min-w-0">
            <span className="block truncate text-lg font-bold tracking-tight">{tBrand('wordmark')}</span>
            <span className="console-muted block truncate text-[11px] font-medium uppercase tracking-wider">
              {tBrand('sidebarSubtitle')}
            </span>
          </span>
        </Link>
        <LocaleSwitcher variant="header" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {ADMIN_NAV_GROUPS.map((group) => (
          <div key={group.groupKey}>
            <h3 className="console-muted mb-1 px-3 text-xs font-semibold uppercase tracking-wider">
              {t(`groups.${group.groupKey}`)}
            </h3>
            <div className="space-y-px">
              {group.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href === '/admin/users' &&
                    (pathname === '/admin/users' || pathname?.startsWith('/admin/users/'))) ||
                  (item.href === '/admin/tools' && pathname === '/admin/tools');
                const Icon = NAV_ICONS[item.nameKey];

                return (
                  <Link
                    key={item.nameKey}
                    href={item.href}
					onClick={onNavigate}
                    className={`
                      group flex items-center rounded-md px-3 py-2 text-sm font-medium
                      ${isActive
                        ? 'bg-cyan-50 text-cyan-700'
                        : 'console-nav-link'
                      }
                    `}
                  >
                    <Icon className={`
                      mr-3 h-5 w-5 flex-shrink-0
                      ${isActive ? 'text-cyan-700' : 'console-muted'}
                    `} />
                    {t(`nav.${item.nameKey}`)}
                  </Link>
                );
              })}
              {group.groupKey === 'system' && (
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={isLoggingOut}
                  className="console-nav-link group flex w-full items-center rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowLeftStartOnRectangleIcon className="console-muted mr-3 h-5 w-5 flex-shrink-0" />
                  {isLoggingOut ? tAuth('loggingOut') : tAuth('logout')}
                </button>
              )}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer: links + version */}
      <div className="space-y-3 border-t p-4" style={{ borderColor: 'var(--console-border)' }}>
		<Link href="/account" onClick={onNavigate} className="console-nav-link flex items-center rounded-md px-2 py-1.5 text-xs font-medium">
          {tBrand('product')} · {tPortalSettings('accountCenter')}
        </Link>
        <ConsoleThemeToggle />
        <BrandExternalLinks variant="sidebar" />
        <p className="console-muted text-center text-xs">{t('version', { version: adminAppVersion })}</p>
        <div className="console-muted"><FrontendAttribution compact /></div>
      </div>
      </div>
    </aside>
  );
}
