import type { AdminPermission } from '@/lib/admin-principal';

export type AdminAuthorizationDecision =
	| { kind: 'permission'; permission: AdminPermission }
	| { kind: 'console_only' }
	| { kind: 'authenticated' }
	| { kind: 'deny' };

function readOrWrite(method: string, resource: string): AdminAuthorizationDecision {
	const suffix = method === 'GET' || method === 'HEAD' ? 'read' : 'write';
	return { kind: 'permission', permission: `${resource}.${suffix}` as AdminPermission };
}

export function getAdminAuthorizationDecision(method: string, pathname: string): AdminAuthorizationDecision {
	const normalizedMethod = method.toUpperCase();
	if (normalizedMethod === 'OPTIONS') return { kind: 'authenticated' };
	if (pathname === '/admin' && normalizedMethod === 'GET') return { kind: 'authenticated' };
	if (pathname.startsWith('/admin/access-keys')) {
		return { kind: 'console_only' };
	}
	if (/^\/admin\/providers\/[^/]+\/api-key$/.test(pathname) && normalizedMethod === 'GET') {
		return { kind: 'permission', permission: 'providers.secrets.read' };
	}
	if (pathname.startsWith('/admin/providers')) return readOrWrite(normalizedMethod, 'providers');
	// 用户共享密钥池治理（挂靠 providers 权限域）
	if (pathname.startsWith('/admin/shared-keys')) return readOrWrite(normalizedMethod, 'providers');
	// 门户账本：提现 / NFT 铸造（挂靠 users 权限域）
	if (pathname.startsWith('/admin/withdrawals')) return readOrWrite(normalizedMethod, 'users');
	if (pathname.startsWith('/admin/nft-mints')) return readOrWrite(normalizedMethod, 'users');
	// 门户账本：共享密钥收益补偿（挂靠 users 权限域）
	if (pathname.startsWith('/admin/earnings')) return readOrWrite(normalizedMethod, 'users');
	if (pathname.startsWith('/admin/models')) return readOrWrite(normalizedMethod, 'models');
	if (pathname.startsWith('/admin/presets')) return readOrWrite(normalizedMethod, 'presets');
	if (pathname.startsWith('/admin/guardrails')) return readOrWrite(normalizedMethod, 'guardrails');
	if (pathname.startsWith('/admin/data-policies')) return readOrWrite(normalizedMethod, 'routes');
	if (pathname.startsWith('/admin/endpoints')) return readOrWrite(normalizedMethod, 'routes');
	if (pathname.startsWith('/admin/routes')) return readOrWrite(normalizedMethod, 'routes');
	if (/^\/admin\/users\/[^/]+\/(?:logs|audit-logs)(?:\/|$)/.test(pathname)) {
		return { kind: 'permission', permission: 'logs.read' };
	}
	if (/^\/admin\/keys\/[^/]+\/logs(?:\/|$)/.test(pathname)) {
		return { kind: 'permission', permission: 'logs.read' };
	}
	if (/^\/admin\/users\/[^/]+\/keys(?:\/|$)/.test(pathname)) return readOrWrite(normalizedMethod, 'user_keys');
	if (pathname.startsWith('/admin/users')) return readOrWrite(normalizedMethod, 'users');
	if (pathname.startsWith('/admin/keys')) return readOrWrite(normalizedMethod, 'user_keys');
	if (pathname === '/admin/config' || pathname === '/admin/config/') return readOrWrite(normalizedMethod, 'config');
	if (pathname.startsWith('/admin/business-timezone')) return { kind: 'permission', permission: 'config.read' };
	if (pathname.startsWith('/admin/analytics') || pathname.startsWith('/admin/stats')) {
		return { kind: 'permission', permission: 'analytics.read' };
	}
	if (pathname.startsWith('/admin/request-logs') || pathname.startsWith('/admin/budget-audit-logs')) {
		return { kind: 'permission', permission: 'logs.read' };
	}
	if (pathname.startsWith('/admin/playground')) {
		return { kind: 'permission', permission: 'playground.execute' };
	}
	return { kind: 'deny' };
}
