/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	ChartNoAxesCombined,
	Cloud,
	Code,
	KeyRound,
	Link,
	ListFilter,
	ShieldCheck,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LoginOptions } from '../../auth-popup-contract'
import { PublicAuthAccessLink } from '../auth/PublicAuthAccessLink'
import { PUBLIC_DOCS_URL } from './home-links'

const capabilities = [
	{ key: 'protocols', Icon: Code },
	{ key: 'routing', Icon: ListFilter },
	{ key: 'budgets', Icon: ShieldCheck },
	{ key: 'observability', Icon: ChartNoAxesCombined },
] as const
const steps = [
	{ key: 'providers', Icon: Cloud },
	{ key: 'routes', Icon: Link },
	{ key: 'keys', Icon: KeyRound },
	{ key: 'observe', Icon: ChartNoAxesCombined },
] as const
const surfaces = [
	'/v1/chat/completions',
	'/v1/responses',
	'/v1/images/*',
	'/v1/audio/*',
	'/v1/tools/*',
]
const consoleAccess: LoginOptions = {
	intent: 'admin',
	callbackPath: '/dashboard',
}

export function HomeProductSections() {
	const { t } = useTranslation()
	return (
		<div className='mt-16 space-y-16 sm:space-y-24'>
			<section id='features' className='scroll-mt-24 space-y-6 border-t pt-12'>
				<h2 className='text-3xl font-semibold tracking-tight'>
					{t('cinatoken.home.features.title')}
				</h2>
				<p className='text-muted-foreground max-w-3xl leading-7'>
					{t('cinatoken.home.features.description')}
				</p>
				<div className='bg-muted/40 flex flex-wrap gap-3 rounded-lg border p-4'>
					{surfaces.map((surface) => (
						<code key={surface} className='text-xs break-all'>
							{surface}
						</code>
					))}
				</div>
				<div className='grid gap-5 sm:grid-cols-2 lg:grid-cols-4'>
					{capabilities.map((capability) => (
						<article
							key={capability.key}
							className='bg-card space-y-4 rounded-xl border p-5'
						>
							<capability.Icon
								aria-hidden='true'
								className='text-muted-foreground size-6'
							/>
							<h3 className='text-lg font-semibold'>
								{t(`cinatoken.home.features.items.${capability.key}.title`)}
							</h3>
							<p className='text-muted-foreground text-sm leading-6'>
								{t(
									`cinatoken.home.features.items.${capability.key}.description`
								)}
							</p>
							<p className='text-muted-foreground text-xs leading-5'>
								{t(`cinatoken.home.features.items.${capability.key}.detail`)}
							</p>
						</article>
					))}
				</div>
			</section>
			<section
				id='architecture'
				className='scroll-mt-24 space-y-8 border-t pt-12'
			>
				<h2 className='text-3xl font-semibold tracking-tight'>
					{t('cinatoken.home.steps.title')}
				</h2>
				<ol className='grid gap-5 sm:grid-cols-2 lg:grid-cols-4'>
					{steps.map((step, index) => (
						<li key={step.key} className='space-y-4 rounded-xl border p-5'>
							<div className='flex items-center justify-between gap-3'>
								<span className='text-primary flex size-9 items-center justify-center rounded-full border text-sm font-semibold'>
									{index + 1}
								</span>
								<step.Icon
									aria-hidden='true'
									className='text-muted-foreground size-6'
								/>
							</div>
							<h3 className='text-lg font-semibold'>
								{t(`cinatoken.home.steps.items.${step.key}.title`)}
							</h3>
							<p className='text-muted-foreground text-sm leading-6'>
								{t(`cinatoken.home.steps.items.${step.key}.description`)}
							</p>
						</li>
					))}
				</ol>
			</section>
			<section
				id='deployment'
				className='scroll-mt-24 space-y-8 border-t pt-12'
			>
				<h2 className='text-3xl font-semibold tracking-tight'>
					{t('cinatoken.home.deployment.title')}
				</h2>
				<div className='grid gap-5 md:grid-cols-2'>
					{(
						[
							['cloudflare', 'Cloudflare Workers + D1'],
							['docker', 'Docker + Postgres / MySQL'],
						] as const
					).map(([key, title]) => (
						<article
							key={key}
							className='bg-card space-y-4 rounded-xl border p-6'
						>
							<h3 className='text-xl font-semibold'>{title}</h3>
							<p className='text-muted-foreground text-sm leading-7'>
								{t(`cinatoken.home.deployment.${key}`)}
							</p>
							<a
								href={PUBLIC_DOCS_URL}
								target='_blank'
								rel='noopener noreferrer'
								className='text-primary inline-block text-sm font-medium underline underline-offset-4'
							>
								{t('cinatoken.home.cta.deploymentDocs')}
							</a>
						</article>
					))}
				</div>
			</section>
			<section className='space-y-5 rounded-2xl border p-8 text-center sm:p-12'>
				<h2 className='text-3xl font-semibold tracking-tight'>
					{t('cinatoken.home.cta.title')}
				</h2>
				<p className='text-muted-foreground mx-auto max-w-2xl leading-7'>
					{t('cinatoken.home.cta.description')}
				</p>
				<div className='flex flex-wrap justify-center gap-3'>
					<PublicAuthAccessLink
						options={consoleAccess}
						href='/dashboard'
						className='bg-primary text-primary-foreground rounded-lg px-5 py-3 text-sm font-medium'
					>
						{t('cinatoken.home.cta.console')}
					</PublicAuthAccessLink>
					<a
						href={PUBLIC_DOCS_URL}
						target='_blank'
						rel='noopener noreferrer'
						className='rounded-lg border px-5 py-3 text-sm font-medium'
					>
						{t('cinatoken.home.cta.deploymentDocs')}
					</a>
				</div>
			</section>
		</div>
	)
}
