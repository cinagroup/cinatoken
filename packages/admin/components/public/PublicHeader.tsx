'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import LocaleSwitcher from '@/components/layout/LocaleSwitcher';
import HomeThemeSwitcher from '@/components/home/HomeThemeSwitcher';
import { CINATOKEN_GITHUB_DOCS_INDEX } from '@/lib/brand';

export default function PublicHeader() {
	const pathname = usePathname();
	const t = useTranslations('publicNav');
	const tBrand = useTranslations('brand');

	return (
		<header className="home-border home-header sticky top-0 z-50 border-b backdrop-blur-xl">
			<div className="mx-auto flex h-16 max-w-[1440px] items-center gap-5 px-4 sm:px-8 lg:px-12">
				<Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label={t('homeLabel')}>
					<Image
						src="/brand/logo.png"
						alt={tBrand('logoAlt')}
						width={36}
						height={36}
						priority
						className="h-8 w-8 rounded-lg sm:h-9 sm:w-9"
					/>
					<span className="home-text hidden truncate text-lg font-semibold tracking-[-0.035em] sm:inline sm:text-xl">
						{tBrand('wordmark')}
					</span>
				</Link>

				<nav className="ml-5 hidden items-center gap-4 lg:flex xl:ml-8 xl:gap-6" aria-label={t('label')}>
					<Link
						href="/models"
						aria-current={pathname.startsWith('/models') ? 'page' : undefined}
						className={`home-hover-text text-sm transition-colors ${pathname.startsWith('/models') ? 'home-text' : 'home-muted'}`}
					>
						{t('models')}
					</Link>
					<Link href="/rankings" aria-current={pathname === '/rankings' ? 'page' : undefined} className={`home-hover-text text-sm transition-colors ${pathname === '/rankings' ? 'home-text' : 'home-muted'}`}>{t('rankings')}</Link>
					<Link href="/benchmarks" aria-current={pathname === '/benchmarks' ? 'page' : undefined} className={`home-hover-text text-sm transition-colors ${pathname === '/benchmarks' ? 'home-text' : 'home-muted'}`}>{t('benchmarks')}</Link>
					<Link href="/chat" aria-current={pathname === '/chat' ? 'page' : undefined} className={`home-hover-text text-sm transition-colors ${pathname === '/chat' ? 'home-text' : 'home-muted'}`}>{t('chat')}</Link>
					<Link
						href="/providers"
						aria-current={pathname === '/providers' ? 'page' : undefined}
						className={`home-hover-text text-sm transition-colors ${pathname === '/providers' ? 'home-text' : 'home-muted'}`}
					>
						{t('providers')}
					</Link>
					<a
						href={CINATOKEN_GITHUB_DOCS_INDEX}
						target="_blank"
						rel="noreferrer"
						className="home-muted home-hover-text text-sm transition-colors"
					>
						{t('docs')}
					</a>
				</nav>

				<div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
					<HomeThemeSwitcher />
					<LocaleSwitcher variant="public" />
					<Link
						href="/account"
						className="home-muted home-hover-text hidden h-9 items-center justify-center whitespace-nowrap rounded-lg border border-transparent px-3 text-sm font-medium transition sm:inline-flex"
					>
						{t('portal')}
					</Link>
					<Link
						href="/dashboard"
						className="home-console-button inline-flex h-9 items-center justify-center whitespace-nowrap rounded-lg border px-3 text-xs font-medium transition sm:px-4 sm:text-sm"
					>
						{t('console')}
					</Link>
				</div>
			</div>
		</header>
	);
}
