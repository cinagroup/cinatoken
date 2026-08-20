import type { ComponentType, ReactNode, SVGProps } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
	ArrowRightIcon,
	ChartBarSquareIcon,
	CloudIcon,
	CodeBracketIcon,
	CommandLineIcon,
	CubeTransparentIcon,
	KeyIcon,
	LinkIcon,
	QueueListIcon,
	ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import LocaleSwitcher from '@/components/layout/LocaleSwitcher';
import { CINATOKEN_GITHUB_DOCS_INDEX, CINATOKEN_GITHUB_REPO_WEB } from '@/lib/brand';
import GatewayDemo from './GatewayDemo';

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

function ArrowLink({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
	const className = primary
		? 'group inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-cyan-600 px-6 text-sm font-semibold text-white shadow-[0_12px_28px_-16px_rgba(8,145,178,0.9)] transition hover:-translate-y-0.5 hover:bg-cyan-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2'
		: 'group inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-6 text-sm font-semibold text-slate-800 transition hover:-translate-y-0.5 hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2';

	if (href.startsWith('http')) {
		return (
			<a href={href} target="_blank" rel="noreferrer" className={className}>
				{children}
				<ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
			</a>
		);
	}

	return (
		<Link href={href} className={className}>
			{children}
			<ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
		</Link>
	);
}

export default async function PublicHome() {
	const t = await getTranslations('home');

	return (
		<div className="min-h-screen overflow-x-hidden bg-white text-slate-950">
			<header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/95 backdrop-blur-xl">
				<div className="mx-auto flex h-[72px] max-w-7xl items-center gap-5 px-5 sm:px-8">
					<Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label={t('nav.homeLabel')}>
						<Image src="/brand/logo.png" alt={t('logoAlt')} width={42} height={42} priority className="h-10 w-10 rounded-xl" />
						<span className="truncate text-xl font-black tracking-[-0.03em] text-slate-950 sm:text-2xl">cinatoken</span>
					</Link>

					<nav className="ml-8 hidden items-center gap-8 lg:flex" aria-label={t('nav.label')}>
						<a href="#features" className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-950">{t('nav.features')}</a>
						<a href="#architecture" className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-950">{t('nav.architecture')}</a>
						<a href="#deployment" className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-950">{t('nav.deployment')}</a>
						<a href={CINATOKEN_GITHUB_DOCS_INDEX} target="_blank" rel="noreferrer" className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-950">{t('nav.docs')}</a>
					</nav>

					<div className="ml-auto flex items-center gap-2 sm:gap-3">
						<LocaleSwitcher variant="login" />
						<Link href="/dashboard" className="inline-flex h-10 items-center justify-center rounded-lg bg-cyan-600 px-3.5 text-xs font-semibold text-white transition hover:bg-cyan-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 sm:px-5 sm:text-sm">
							{t('nav.console')}
						</Link>
					</div>
				</div>
			</header>

			<main>
				<section className="relative isolate overflow-hidden border-b border-cyan-100/70 bg-white px-5 pb-20 pt-16 sm:px-8 sm:pb-28 sm:pt-24 lg:pt-28">
					<div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_16%_44%,rgba(14,165,233,0.09),transparent_30%),radial-gradient(circle_at_88%_12%,rgba(6,182,212,0.06),transparent_26%)]" />
					<div className="mx-auto grid max-w-[1380px] items-center gap-14 lg:grid-cols-[0.98fr_1.02fr] lg:gap-16">
						<div className="home-enter">
							<h1 className="max-w-2xl text-[clamp(2.75rem,5vw,4rem)] font-black leading-[1.08] tracking-[-0.05em] text-slate-950">
								{t('hero.titleLine1')}
								<br />
								{t('hero.titleLine2')}
							</h1>
							<p className="mt-7 max-w-xl text-base leading-8 text-slate-600 sm:text-lg">
								{t('hero.description')}
							</p>
							<div className="mt-9 flex flex-col gap-3 sm:flex-row">
								<ArrowLink href="/dashboard" primary>{t('hero.console')}</ArrowLink>
								<ArrowLink href={CINATOKEN_GITHUB_DOCS_INDEX}>{t('hero.docs')}</ArrowLink>
							</div>

							<div className="relative mt-14 hidden h-16 lg:block" aria-hidden>
								<svg className="absolute -left-[18vw] top-0 h-20 w-[54vw] overflow-visible" viewBox="0 0 900 90" fill="none">
									<path d="M0 62H430C510 62 500 16 590 16H900" stroke="#06b6d4" strokeWidth="3" />
									<path d="M430 62C540 62 525 40 650 40H900" stroke="#bae6fd" strokeWidth="2" strokeDasharray="7 8" />
									<circle cx="430" cy="62" r="7" fill="white" stroke="#06b6d4" strokeWidth="3" />
								</svg>
							</div>
						</div>

						<div className="home-enter home-enter-delay">
							<GatewayDemo />
						</div>
					</div>
				</section>

				<section id="features" className="scroll-mt-24 bg-cyan-50/45 px-5 py-20 sm:px-8 sm:py-28">
					<div className="mx-auto max-w-7xl">
						<div className="mx-auto max-w-3xl text-center">
							<h2 className="text-3xl font-black tracking-[-0.035em] text-slate-950 sm:text-5xl">{t('features.title')}</h2>
							<p className="mt-5 text-base leading-7 text-slate-600 sm:text-lg">{t('features.description')}</p>
						</div>

						<div className="mt-12 overflow-x-auto rounded-2xl border border-cyan-200/80 bg-white shadow-[0_18px_50px_-40px_rgba(14,116,144,0.55)]">
							<div className="flex min-w-[860px] items-center divide-x divide-slate-200">
								{PROTOCOLS.map((protocol) => (
									<div key={protocol} className="flex flex-1 items-center gap-3 px-5 py-5 font-mono text-xs text-slate-700">
										<span className="h-2 w-2 rounded-full border-2 border-cyan-500" />
										{protocol}
									</div>
								))}
							</div>
						</div>

						<div className="relative mt-16 grid gap-10 lg:grid-cols-2 lg:gap-x-32 lg:gap-y-16">
							<div className="absolute bottom-14 left-1/2 top-14 hidden w-px -translate-x-1/2 bg-cyan-200 lg:block" aria-hidden />
							{CAPABILITIES.map((capability, index) => {
								const Icon = capability.icon;
								return (
									<article key={capability.key} className={`relative flex gap-5 ${index % 2 === 1 ? 'lg:translate-y-14' : ''}`}>
										<div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-cyan-200 bg-white text-cyan-600 shadow-sm">
											<Icon className="h-7 w-7" aria-hidden />
										</div>
										<div className="pt-1">
											<h3 className="text-2xl font-bold tracking-[-0.025em] text-slate-950">{t(`features.items.${capability.key}.title`)}</h3>
											<p className="mt-3 max-w-lg text-sm leading-7 text-slate-600">{t(`features.items.${capability.key}.description`)}</p>
											<p className="mt-3 font-mono text-xs leading-6 text-slate-500">{t(`features.items.${capability.key}.detail`)}</p>
										</div>
									</article>
								);
							})}
						</div>
					</div>
				</section>

				<section id="architecture" className="scroll-mt-24 bg-white px-5 py-20 sm:px-8 sm:py-28">
					<div className="mx-auto max-w-7xl">
						<h2 className="text-center text-3xl font-black tracking-[-0.035em] text-slate-950 sm:text-5xl">{t('steps.title')}</h2>
						<div className="relative mt-16 grid gap-10 md:grid-cols-4 md:gap-6">
							<div className="absolute left-[12.5%] right-[12.5%] top-5 hidden h-px bg-cyan-300 md:block" aria-hidden />
							{STEPS.map((step, index) => {
								const Icon = step.icon;
								return (
									<article key={step.key} className="relative text-center">
										<div className="relative z-10 mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-cyan-300 bg-white text-sm font-bold text-cyan-700">{index + 1}</div>
										<div className="mx-auto mt-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-200 bg-cyan-50 text-cyan-600">
											<Icon className="h-8 w-8" aria-hidden />
										</div>
										<h3 className="mt-5 text-lg font-bold text-slate-950">{t(`steps.items.${step.key}.title`)}</h3>
										<p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-slate-600">{t(`steps.items.${step.key}.description`)}</p>
									</article>
								);
							})}
						</div>
					</div>
				</section>

				<section id="deployment" className="scroll-mt-24 bg-[#101923] px-5 py-20 text-white sm:px-8 sm:py-24">
					<div className="mx-auto max-w-6xl">
						<h2 className="text-center text-3xl font-black tracking-[-0.035em] sm:text-4xl">{t('deployment.title')}</h2>
						<div className="mt-10 grid gap-5 md:grid-cols-2">
							<div className="flex items-center gap-5 rounded-2xl border border-slate-600/80 bg-white/[0.025] p-6 sm:p-8">
								<CloudIcon className="h-12 w-12 shrink-0 text-cyan-400" aria-hidden />
								<div>
									<h3 className="text-lg font-bold">Cloudflare Workers + D1</h3>
									<p className="mt-2 text-sm leading-6 text-slate-300">{t('deployment.cloudflare')}</p>
								</div>
							</div>
							<div className="flex items-center gap-5 rounded-2xl border border-slate-600/80 bg-white/[0.025] p-6 sm:p-8">
								<CubeTransparentIcon className="h-12 w-12 shrink-0 text-cyan-400" aria-hidden />
								<div>
									<h3 className="text-lg font-bold">Docker + Postgres / MySQL</h3>
									<p className="mt-2 text-sm leading-6 text-slate-300">{t('deployment.docker')}</p>
								</div>
							</div>
						</div>
					</div>
				</section>

				<section className="bg-white px-5 py-20 text-center sm:px-8 sm:py-28">
					<div className="mx-auto max-w-3xl">
						<CommandLineIcon className="mx-auto h-10 w-10 text-cyan-600" aria-hidden />
						<h2 className="mt-6 text-3xl font-black tracking-[-0.035em] text-slate-950 sm:text-5xl">{t('cta.title')}</h2>
						<p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">{t('cta.description')}</p>
						<div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
							<ArrowLink href="/dashboard" primary>{t('cta.console')}</ArrowLink>
							<ArrowLink href={CINATOKEN_GITHUB_DOCS_INDEX}>{t('cta.deploymentDocs')}</ArrowLink>
						</div>
					</div>
				</section>
			</main>

			<footer className="border-t border-slate-200 bg-white px-5 py-8 sm:px-8">
				<div className="mx-auto flex max-w-7xl flex-col gap-6 sm:flex-row sm:items-center">
					<div className="flex items-center gap-3">
						<Image src="/brand/logo.png" alt="" width={36} height={36} className="h-9 w-9 rounded-lg" aria-hidden />
						<div>
							<p className="font-bold text-slate-950">cinatoken</p>
							<p className="text-xs text-slate-500">{t('footer.description')}</p>
						</div>
					</div>
					<div className="flex items-center gap-6 text-sm text-slate-600 sm:ml-auto">
						<a href={CINATOKEN_GITHUB_REPO_WEB} target="_blank" rel="noreferrer" className="transition hover:text-slate-950">GitHub</a>
						<a href={CINATOKEN_GITHUB_DOCS_INDEX} target="_blank" rel="noreferrer" className="transition hover:text-slate-950">{t('nav.docs')}</a>
					</div>
					<p className="text-xs text-slate-500 sm:ml-8">© 2026 CinaGroup</p>
				</div>
			</footer>
		</div>
	);
}
