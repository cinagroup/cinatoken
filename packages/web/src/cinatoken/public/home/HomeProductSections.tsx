/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { PUBLIC_DOCS_URL } from './home-links'

const capabilities = [
	'protocols',
	'routing',
	'budgets',
	'observability',
] as const
const steps = ['providers', 'routes', 'keys', 'observe'] as const
const deployments = [
	['cloudflare', 'Cloudflare Workers + D1'],
	['docker', 'Docker + Postgres / MySQL'],
] as const

export function HomeProductSections() {
	const { t } = useTranslation()
	return (
		<div className='space-y-12 py-12 sm:space-y-16 sm:py-16'>
			<section
				id='features'
				className='grid scroll-mt-8 gap-6 md:grid-cols-[1fr_3fr] md:gap-12'
			>
				<div>
					<h2 className='text-2xl font-semibold tracking-tight'>
						{t('cinatoken.home.features.title')}
					</h2>
					<p className='text-muted-foreground mt-3 text-sm leading-6'>
						{t('cinatoken.home.features.description')}
					</p>
					<nav
						aria-label={t('cinatoken.home.nav.label')}
						className='text-muted-foreground mt-5 flex flex-wrap gap-5 text-sm'
					>
						{(['features', 'architecture', 'deployment'] as const).map(
							(section) => (
								<a
									key={section}
									href={`#${section}`}
									className='hover:text-foreground focus-visible:outline-ring rounded-sm underline underline-offset-4'
								>
									{t(`cinatoken.home.nav.${section}`)}
								</a>
							)
						)}
					</nav>
				</div>
				<dl className='divide-y border-y'>
					{capabilities.map((key) => (
						<div
							key={key}
							className='grid gap-2 py-5 sm:grid-cols-[10rem_1fr] sm:gap-5'
						>
							<dt className='text-sm font-medium'>
								{t(`cinatoken.home.features.items.${key}.title`)}
							</dt>
							<dd className='text-muted-foreground text-sm leading-6'>
								{t(`cinatoken.home.features.items.${key}.description`)}
							</dd>
						</div>
					))}
				</dl>
			</section>
			<section
				id='architecture'
				className='grid scroll-mt-8 gap-6 md:grid-cols-[1fr_3fr] md:gap-12'
			>
				<h2 className='text-2xl font-semibold tracking-tight'>
					{t('cinatoken.home.steps.title')}
				</h2>
				<ol className='divide-y border-y'>
					{steps.map((key, index) => (
						<li
							key={key}
							className='grid grid-cols-[1.5rem_1fr] items-baseline gap-x-3 gap-y-2 py-5 sm:grid-cols-[1.5rem_9rem_1fr] sm:gap-x-5'
						>
							<span
								aria-hidden='true'
								className='text-muted-foreground font-mono text-xs'
							>
								{String(index + 1).padStart(2, '0')}
							</span>
							<h3 className='text-sm font-medium'>
								{t(`cinatoken.home.steps.items.${key}.title`)}
							</h3>
							<p className='text-muted-foreground col-start-2 text-sm leading-6 sm:col-start-auto'>
								{t(`cinatoken.home.steps.items.${key}.description`)}
							</p>
						</li>
					))}
				</ol>
			</section>
			<section
				id='deployment'
				className='grid scroll-mt-8 gap-6 md:grid-cols-[1fr_3fr] md:gap-12'
			>
				<h2 className='text-2xl font-semibold tracking-tight'>
					{t('cinatoken.home.deployment.title')}
				</h2>
				<div className='divide-y border-y'>
					{deployments.map(([key, title]) => (
						<article
							key={key}
							className='grid gap-3 py-5 sm:grid-cols-[14rem_1fr] sm:gap-5'
						>
							<h3 className='text-sm font-medium'>{title}</h3>
							<div className='space-y-3 text-sm leading-6'>
								<p className='text-muted-foreground'>
									{t(`cinatoken.home.deployment.${key}`)}
								</p>
								<a
									href={PUBLIC_DOCS_URL}
									target='_blank'
									rel='noopener noreferrer'
									className='hover:text-muted-foreground focus-visible:outline-ring rounded-sm underline underline-offset-4'
								>
									{t('cinatoken.home.deployment.docs')}
								</a>
							</div>
						</article>
					))}
				</div>
			</section>
		</div>
	)
}
