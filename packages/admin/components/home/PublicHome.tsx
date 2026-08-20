import type { ComponentType, ReactNode, SVGProps } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
	ArrowRightIcon,
	ChartBarSquareIcon,
	CloudIcon,
	CodeBracketIcon,
	CubeTransparentIcon,
	KeyIcon,
	LinkIcon,
	QueueListIcon,
	ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import LocaleSwitcher from '@/components/layout/LocaleSwitcher';
import { CINATOKEN_GITHUB_DOCS_INDEX, CINATOKEN_GITHUB_REPO_WEB } from '@/lib/brand';
import GatewayDemo from './GatewayDemo';
import HomeThemeSwitcher from './HomeThemeSwitcher';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

const CAPABILITIES: Array<{
	key: 'protocols' | 'routing' | 'budgets' | 'observability';
	icon: IconComponent;
}> = [
	{ key: 'protocols', icon: CodeBracketIcon },
	{ key: 'routing', icon: QueueListIcon },
	{ key: 'budgets', icon: ShieldCheckIcon },
	{ key: 'observability', icon: ChartBarSquareIcon },
];

const PROTOCOLS = [
	'/v1/chat/completions',
	'/v1/responses',
	'/v1/images/*',
	'/v1/audio/*',
	'/v1/tools/*',
];

const STEPS: Array<{
	key: 'providers' | 'routes' | 'keys' | 'observe';
	icon: IconComponent;
}> = [
	{ key: 'providers', icon: CloudIcon },
	{ key: 'routes', icon: LinkIcon },
	{ key: 'keys', icon: KeyIcon },
	{ key: 'observe', icon: ChartBarSquareIcon },
];

const HOME_THEME_BOOTSTRAP = `(() => {
	let stored = null;
	try {
		stored = localStorage.getItem('cinatoken.home-theme.v1');
	} catch {}
	if (stored !== 'light' && stored !== 'dark' && stored !== 'system') {
		stored = (document.cookie || '')
			.split('; ')
			.find((entry) => entry.startsWith('cinatoken_home_theme='))
			?.slice('cinatoken_home_theme='.length) ?? null;
	}
	const preference = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
	const resolved = preference === 'system'
		? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
		: preference;
	document.documentElement.dataset.homeThemePreference = preference;
	document.documentElement.dataset.homeTheme = resolved;
})();`;

function ArrowLink({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
	const className = primary
		? 'home-action home-action-primary group inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition'
		: 'home-action home-action-secondary group inline-flex h-11 items-center justify-center gap-2 rounded-full border px-5 text-sm font-medium transition';

	const content = (
		<>
			{children}
			<ArrowRightIcon className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
		</>
	);

	if (href.startsWith('http')) {
		return (
			<a href={href} target="_blank" rel="noreferrer" className={className}>
				{content}
			</a>
		);
	}

	return (
		<Link href={href} className={className}>
			{content}
		</Link>
	);
}

export default async function PublicHome() {
	const t = await getTranslations('home');

	return (
		<>
			<script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: HOME_THEME_BOOTSTRAP }} />
			<div className="home-surface min-h-screen overflow-x-hidden">
			<header className="home-border home-header sticky top-0 z-50 border-b backdrop-blur-xl">
				<div className="mx-auto flex h-16 max-w-[1440px] items-center gap-5 px-5 sm:px-8 lg:px-12">
					<Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label={t('nav.homeLabel')}>
						<Image src="/brand/logo.png" alt={t('logoAlt')} width={36} height={36} priority className="h-8 w-8 rounded-lg sm:h-9 sm:w-9" />
						<span className="home-text hidden truncate text-lg font-semibold tracking-[-0.035em] sm:inline sm:text-xl">cinatoken</span>
					</Link>

					<nav className="ml-10 hidden items-center gap-8 lg:flex" aria-label={t('nav.label')}>
						<a href="#features" className="home-muted home-hover-text text-sm transition-colors">{t('nav.features')}</a>
						<a href="#architecture" className="home-muted home-hover-text text-sm transition-colors">{t('nav.architecture')}</a>
						<a href="#deployment" className="home-muted home-hover-text text-sm transition-colors">{t('nav.deployment')}</a>
						<a href={CINATOKEN_GITHUB_DOCS_INDEX} target="_blank" rel="noreferrer" className="home-muted home-hover-text text-sm transition-colors">{t('nav.docs')}</a>
					</nav>

					<div className="ml-auto flex items-center gap-2.5">
						<HomeThemeSwitcher />
						<LocaleSwitcher variant="login" />
						<Link href="/dashboard" className="home-console-button inline-flex h-9 items-center justify-center whitespace-nowrap rounded-lg border px-3 text-xs font-medium transition sm:px-4 sm:text-sm">
							{t('nav.console')}
						</Link>
					</div>
				</div>
			</header>

			<main>
				<section className="home-border relative border-b px-5 pb-16 pt-14 sm:px-8 sm:pb-20 sm:pt-20 lg:px-12 lg:pb-24 lg:pt-24">
					<div className="home-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
					<div className="relative mx-auto max-w-[1360px]">
						<div className="grid min-h-[500px] items-center gap-10 lg:grid-cols-[0.84fr_1.16fr] lg:gap-4">
							<div className="home-enter relative z-10 max-w-2xl py-5">
								<h1 className="home-text text-[clamp(3rem,5vw,5rem)] font-semibold leading-[0.94] tracking-[-0.06em]">
									{t('hero.titleLine1')}
									<br />
									{t('hero.titleLine2')}
								</h1>
								<p className="home-muted mt-7 max-w-xl text-base leading-7 sm:text-lg sm:leading-8">
									{t('hero.description')}
								</p>
								<div className="mt-8 flex flex-col gap-3 sm:flex-row">
									<ArrowLink href="/dashboard" primary>{t('hero.console')}</ArrowLink>
									<ArrowLink href={CINATOKEN_GITHUB_DOCS_INDEX}>{t('hero.docs')}</ArrowLink>
								</div>
							</div>

							<div className="home-enter home-enter-delay home-hero-visual relative -mx-16 min-h-[390px] sm:-mx-10 lg:mx-0 lg:min-h-[520px]" aria-hidden />
						</div>

						<div className="home-enter home-enter-delay relative z-20 -mt-2 sm:mt-0">
							<GatewayDemo />
						</div>
					</div>
				</section>

				<section id="features" className="home-border scroll-mt-20 border-b px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
					<div className="mx-auto max-w-[1360px]">
						<div className="max-w-3xl">
							<h2 className="home-text text-3xl font-semibold tracking-[-0.045em] sm:text-5xl">{t('features.title')}</h2>
							<p className="home-subtle mt-5 max-w-2xl text-base leading-7 sm:text-lg">{t('features.description')}</p>
						</div>

						<div className="home-border-strong mt-12 overflow-x-auto border-y">
							<div className="flex min-w-[880px] items-center">
								{PROTOCOLS.map((protocol) => (
									<div key={protocol} className="home-border-strong home-muted group flex flex-1 items-center gap-3 border-r px-5 py-5 font-mono text-xs last:border-r-0">
										<span className="h-1.5 w-1.5 rounded-full bg-sky-500 shadow-[0_0_12px_rgba(14,165,233,0.8)] transition-transform group-hover:scale-150" />
										{protocol}
									</div>
								))}
							</div>
						</div>

						<div className="home-border-strong grid border-b md:grid-cols-2 lg:grid-cols-4">
							{CAPABILITIES.map((capability) => {
								const Icon = capability.icon;
								return (
									<article key={capability.key} className="home-border-strong border-b px-1 py-10 md:px-7 lg:border-b-0 lg:border-r lg:px-8 lg:last:border-r-0">
										<Icon className="home-muted h-6 w-6" strokeWidth={1.4} aria-hidden />
										<h3 className="home-text mt-8 text-xl font-medium tracking-[-0.025em]">{t(`features.items.${capability.key}.title`)}</h3>
										<p className="home-subtle mt-3 text-sm leading-6">{t(`features.items.${capability.key}.description`)}</p>
										<p className="home-faint mt-5 font-mono text-[11px] leading-5">{t(`features.items.${capability.key}.detail`)}</p>
									</article>
								);
							})}
						</div>
					</div>
				</section>

				<section id="architecture" className="home-border scroll-mt-20 border-b px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
					<div className="mx-auto max-w-[1360px]">
						<h2 className="home-text max-w-3xl text-3xl font-semibold tracking-[-0.045em] sm:text-5xl">{t('steps.title')}</h2>
						<div className="relative mt-14 grid gap-10 md:grid-cols-4 md:gap-0">
							<div className="home-divider absolute left-[12.5%] right-[12.5%] top-5 hidden h-px md:block" aria-hidden />
							{STEPS.map((step, index) => {
								const Icon = step.icon;
								return (
									<article key={step.key} className="relative md:px-5 md:first:pl-0 md:last:pr-0">
										<div className="home-step-number relative z-10 flex h-10 w-10 items-center justify-center rounded-full border border-sky-600 font-mono text-xs text-sky-400">{index + 1}</div>
										<Icon className="home-subtle mt-8 h-6 w-6" strokeWidth={1.4} aria-hidden />
										<h3 className="home-text mt-5 text-lg font-medium">{t(`steps.items.${step.key}.title`)}</h3>
										<p className="home-subtle mt-2 max-w-xs text-sm leading-6">{t(`steps.items.${step.key}.description`)}</p>
									</article>
								);
							})}
						</div>
					</div>
				</section>

				<section id="deployment" className="home-border scroll-mt-20 border-b px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
					<div className="mx-auto max-w-[1360px]">
						<h2 className="home-text text-3xl font-semibold tracking-[-0.045em] sm:text-5xl">{t('deployment.title')}</h2>
						<div className="home-border-strong mt-12 grid overflow-hidden rounded-2xl border md:grid-cols-2">
							<div className="home-border-strong flex min-h-56 items-start gap-6 border-b p-7 sm:p-10 md:border-b-0 md:border-r">
								<CloudIcon className="home-muted h-10 w-10 shrink-0" strokeWidth={1.2} aria-hidden />
								<div>
									<h3 className="home-text text-xl font-medium">Cloudflare Workers + D1</h3>
									<p className="home-subtle mt-4 max-w-md text-sm leading-6">{t('deployment.cloudflare')}</p>
									<a href={CINATOKEN_GITHUB_DOCS_INDEX} target="_blank" rel="noreferrer" className="mt-7 inline-flex items-center gap-2 text-sm text-sky-400 transition hover:text-sky-300">
										{t('cta.deploymentDocs')} <ArrowRightIcon className="h-3.5 w-3.5" aria-hidden />
									</a>
								</div>
							</div>
							<div className="flex min-h-56 items-start gap-6 p-7 sm:p-10">
								<CubeTransparentIcon className="home-muted h-10 w-10 shrink-0" strokeWidth={1.2} aria-hidden />
								<div>
									<h3 className="home-text text-xl font-medium">Docker + Postgres / MySQL</h3>
									<p className="home-subtle mt-4 max-w-md text-sm leading-6">{t('deployment.docker')}</p>
									<a href={CINATOKEN_GITHUB_DOCS_INDEX} target="_blank" rel="noreferrer" className="mt-7 inline-flex items-center gap-2 text-sm text-sky-400 transition hover:text-sky-300">
										{t('cta.deploymentDocs')} <ArrowRightIcon className="h-3.5 w-3.5" aria-hidden />
									</a>
								</div>
							</div>
						</div>
					</div>
				</section>

				<section className="px-5 py-24 text-center sm:px-8 sm:py-32 lg:px-12">
					<div className="mx-auto max-w-3xl">
						<h2 className="home-text text-3xl font-semibold tracking-[-0.045em] sm:text-5xl">{t('cta.title')}</h2>
						<p className="home-subtle mx-auto mt-5 max-w-2xl text-base leading-7 sm:text-lg">{t('cta.description')}</p>
						<div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
							<ArrowLink href="/dashboard" primary>{t('cta.console')}</ArrowLink>
							<ArrowLink href={CINATOKEN_GITHUB_DOCS_INDEX}>{t('cta.deploymentDocs')}</ArrowLink>
						</div>
					</div>
				</section>
			</main>

			<footer className="home-border border-t px-5 py-9 sm:px-8 lg:px-12">
				<div className="mx-auto flex max-w-[1360px] flex-col gap-7 sm:flex-row sm:items-center">
					<div className="flex items-center gap-3">
						<Image src="/brand/logo.png" alt="" width={32} height={32} className="h-8 w-8 rounded-lg" aria-hidden />
						<div>
							<p className="home-text font-medium">cinatoken</p>
							<p className="home-faint mt-0.5 text-xs">{t('footer.description')}</p>
						</div>
					</div>
					<div className="home-subtle flex items-center gap-6 text-sm sm:ml-auto">
						<a href={CINATOKEN_GITHUB_REPO_WEB} target="_blank" rel="noreferrer" className="home-hover-text transition">GitHub</a>
						<a href={CINATOKEN_GITHUB_DOCS_INDEX} target="_blank" rel="noreferrer" className="home-hover-text transition">{t('nav.docs')}</a>
					</div>
					<p className="home-faint text-xs sm:ml-8">© 2026 CinaGroup</p>
				</div>
			</footer>
			</div>
		</>
	);
}
