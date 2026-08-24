/**
 * 管理后台侧栏路由（不含图标）。DocumentTitle 与 Sidebar 共用，保证标签页标题与导航文案一致。
 */

export type AdminNavNameKey =
	| 'dashboard'
	| 'providers'
	| 'models'
	| 'routes'
	| 'playground'
	| 'simulator'
	| 'users'
	| 'apiKeys'
	| 'sharedKeys'
	| 'requestLogs'
	| 'auditLogs'
	| 'toolsConfig'
	| 'toolInvocations'
	| 'modelUsage'
	| 'providerUsage'
	| 'userUsage'
	| 'reliability'
	| 'adminApiKeys'
	| 'withdrawals'
	| 'nftMints'
	| 'config';

export type AdminNavGroupKey =
	| 'overview'
	| 'inference'
	| 'user'
	| 'tools'
	| 'analytics'
	| 'integration'
	| 'system';

export interface AdminNavRoute {
	nameKey: AdminNavNameKey;
	href: string;
}

export interface AdminNavGroup {
	groupKey: AdminNavGroupKey;
	items: AdminNavRoute[];
}

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
	{
		groupKey: 'overview',
		items: [{ nameKey: 'dashboard', href: '/dashboard' }],
	},
	{
		groupKey: 'inference',
		items: [
			{ nameKey: 'providers', href: '/admin/providers' },
			{ nameKey: 'models', href: '/admin/models' },
			{ nameKey: 'routes', href: '/admin/routes' },
			{ nameKey: 'playground', href: '/admin/playground' },
			{ nameKey: 'simulator', href: '/admin/simulator' },
		],
	},
	{
		groupKey: 'user',
		items: [
			{ nameKey: 'users', href: '/admin/users' },
			{ nameKey: 'apiKeys', href: '/admin/keys' },
			{ nameKey: 'sharedKeys', href: '/admin/shared-keys' },
			{ nameKey: 'requestLogs', href: '/admin/request-logs' },
			{ nameKey: 'auditLogs', href: '/admin/audit-logs' },
		],
	},
	{
		groupKey: 'tools',
		items: [
			{ nameKey: 'toolsConfig', href: '/admin/tools' },
			{ nameKey: 'toolInvocations', href: '/admin/tools/invocations' },
		],
	},
	{
		groupKey: 'analytics',
		items: [
			{ nameKey: 'modelUsage', href: '/admin/analytics/models' },
			{ nameKey: 'providerUsage', href: '/admin/analytics/providers' },
			{ nameKey: 'userUsage', href: '/admin/analytics/users' },
			{ nameKey: 'reliability', href: '/admin/analytics/reliability' },
		],
	},
	{
		groupKey: 'integration',
		items: [{ nameKey: 'adminApiKeys', href: '/admin/admin-api-keys' }],
	},
	{
		groupKey: 'system',
		items: [
			{ nameKey: 'withdrawals', href: '/admin/withdrawals' },
			{ nameKey: 'nftMints', href: '/admin/nft-mints' },
			{ nameKey: 'config', href: '/admin/config' },
		],
	},
];

export const ADMIN_NAV_ROUTES: AdminNavRoute[] = ADMIN_NAV_GROUPS.flatMap((group) => group.items);

/** 最长前缀匹配，避免 `/admin/tools/invocations` 落到 Configuration。 */
export function matchAdminNavRoute(pathname: string): AdminNavRoute | null {
	const path = pathname.split('?')[0] || '/';
	let best: AdminNavRoute | null = null;
	for (const item of ADMIN_NAV_ROUTES) {
		if (path === item.href || path.startsWith(`${item.href}/`)) {
			if (!best || item.href.length > best.href.length) {
				best = item;
			}
		}
	}
	return best;
}

export function formatAdminDocumentTitle(page: string | null | undefined, app: string): string {
	const trimmed = page?.trim() ?? '';
	return trimmed ? `${trimmed} · ${app}` : app;
}
