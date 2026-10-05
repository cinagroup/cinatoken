/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { ConsoleGate } from './ConsoleGate'
import { CinaTokenConsoleProvider } from './console-context'

const sections = [
	{
		label: 'resources',
		links: [
			['models', '/admin/models'],
			['endpoints', '/admin/endpoints'],
			['routes', '/admin/routes'],
			['tools', '/admin/tools'],
		],
	},
	{
		label: 'access',
		links: [
			['users', '/admin/users'],
			['keys', '/admin/keys'],
			['integrationKeys', '/admin/admin-api-keys'],
		],
	},
	{
		label: 'observability',
		links: [
			['playground', '/admin/playground'],
			['simulator', '/admin/simulator'],
			['toolInvocations', '/admin/tools/invocations'],
			['modelAnalytics', '/admin/analytics/models'],
			['providerAnalytics', '/admin/analytics/providers'],
			['userAnalytics', '/admin/analytics/users'],
			['reliability', '/admin/analytics/reliability'],
			['requestLogs', '/admin/request-logs'],
			['auditLogs', '/admin/audit-logs'],
		],
	},
	{
		label: 'operations',
		links: [
			['sharedKeys', '/admin/shared-keys'],
			['withdrawals', '/admin/withdrawals'],
			['nftMints', '/admin/nft-mints'],
			['presets', '/admin/presets'],
			['guardrails', '/admin/guardrails'],
			['dataPolicies', '/admin/data-policies'],
			['config', '/admin/config'],
		],
	},
] as const
const sectionPaths = sections
	.flatMap((section) => section.links.map(([, path]) => path))
	.sort((left, right) => right.length - left.length)

function ConsoleNavigation() {
	const { t } = useTranslation()
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	})
	const activePath = sectionPaths.find(
		(path) => pathname === path || pathname.startsWith(path + '/')
	)
	const prefix = 'cinatoken.console.'
	return (
		<nav aria-label={t(prefix + 'navigation')} className='space-y-5 text-sm'>
			<div className='grid grid-cols-2 gap-1 md:grid-cols-1'>
				<Link
					to='/admin'
					activeOptions={{ exact: true }}
					activeProps={{
						className: 'bg-muted font-medium',
						'aria-current': 'page',
					}}
					className='rounded-lg px-3 py-2'
				>
					{t(prefix + 'dashboard')}
				</Link>
				<Link
					to='/admin/providers'
					search={{ q: '', filter: 'all' }}
					activeProps={{
						className: 'bg-muted font-medium',
						'aria-current': 'page',
					}}
					className='rounded-lg px-3 py-2'
				>
					{t(prefix + 'providers')}
				</Link>
			</div>
			{sections.map((section) => (
				<div key={section.label} className='space-y-2'>
					<p className='text-muted-foreground px-3 text-xs font-medium'>
						{t(prefix + section.label)}
					</p>
					<div className='grid grid-cols-2 gap-1 md:grid-cols-1'>
						{section.links.map(([label, path]) => (
							<a
								key={path}
								href={path}
								aria-current={activePath === path ? 'page' : undefined}
								className={cn(
									'hover:bg-muted rounded-lg px-3 py-2',
									activePath === path && 'bg-muted font-medium'
								)}
							>
								{t(prefix + label)}
							</a>
						))}
					</div>
				</div>
			))}
		</nav>
	)
}

export function AdminLayout() {
	const { t } = useTranslation()
	return (
		<CinaTokenConsoleProvider>
			<ConsoleGate>
				<div className='grid items-start gap-8 md:grid-cols-[220px_minmax(0,1fr)]'>
					<aside>
						<details className='rounded-xl border p-3 md:hidden'>
							<summary className='cursor-pointer text-sm font-medium'>
								{t('cinatoken.console.navigation')}
							</summary>
							<div className='pt-4'>
								<ConsoleNavigation />
							</div>
						</details>
						<div className='hidden md:block'>
							<ConsoleNavigation />
						</div>
					</aside>
					<div className='min-w-0'>
						<Outlet />
					</div>
				</div>
			</ConsoleGate>
		</CinaTokenConsoleProvider>
	)
}
