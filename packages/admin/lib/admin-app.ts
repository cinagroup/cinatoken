/**
 * 管理 API Hono 子应用：内部路由为 `/admin/*`；由 Next 对外暴露为 `/api/admin/*`。
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AdminEnv } from '@/lib/admin-env';
import { resolveAdminStorageContext } from '@/lib/storage-context';
import { adminAppVersion } from '@/lib/app-version';
import { adminAnalyticsRoutes } from '@/lib/routes/admin/analytics';
import { adminBudgetAuditLogsRoutes } from '@/lib/routes/admin/budget-audit-logs';
import { adminBusinessTimezoneRoutes } from '@/lib/routes/admin/business-timezone';
import { adminConfigRoutes } from '@/lib/routes/admin/config';
import { adminKeysRoutes } from '@/lib/routes/admin/keys';
import { adminUsersRoutes } from '@/lib/routes/admin/users';
import { adminModelRoutes } from '@/lib/routes/admin/model-routes';
import { adminModelEndpointsRoutes } from '@/lib/routes/admin/model-endpoints';
import { adminModelsRoutes } from '@/lib/routes/admin/models';
import { adminPlaygroundRoutes } from '@/lib/routes/admin/playground';
import { adminProvidersRoutes } from '@/lib/routes/admin/providers';
import { adminRequestLogsRoutes } from '@/lib/routes/admin/request-logs';
import { adminStatsRoutes } from '@/lib/routes/admin/stats';
import { adminAccessKeysRoutes } from '@/lib/routes/admin/access-keys';
import { adminSharedKeysRoutes } from '@/lib/routes/admin/shared-keys';
import { adminEarningsRoutes } from '@/lib/routes/admin/earnings';
import { adminWithdrawalsRoutes } from '@/lib/routes/admin/withdrawals';
import { adminNftMintsRoutes } from '@/lib/routes/admin/nft-mints';
import { adminPresetsRoutes } from '@/lib/routes/admin/presets';
import { adminGuardrailsRoutes } from '@/lib/routes/admin/guardrails';
import { adminDataPoliciesRoutes } from '@/lib/routes/admin/data-policies';
import { getAdminAuthorizationDecision } from '@/lib/admin-permissions';
import { hasAdminPermission } from '@/lib/admin-principal';
import { rejectRateLimitedAdminAuth } from '@/lib/admin-auth-rate-limit';

export function createAdminApp(): Hono<AdminEnv> {
	const app = new Hono<AdminEnv>();

	app.use('*', logger());
	// Admin API is JSON-only — keep bodies small (Node runtime memory safety).
	app.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024 }));
	// CORS 收敛：配置了 CINATOKEN_APP_ORIGIN（逗号分隔）则仅放行这些来源；
	// 未配置时保持 '*'（兼容既有跨源 SDK/脚本用法），但不反射凭据。
	app.use(
		'*',
		cors({
			origin: (origin, c) => {
				const allowed = (c.env?.CINATOKEN_APP_ORIGIN ?? process.env.CINATOKEN_APP_ORIGIN ?? '')
					.split(',')
					.map((value: string) => value.trim())
					.filter(Boolean);
				if (allowed.length === 0) return origin ?? '*';
				return allowed.includes(origin) ? origin : allowed[0];
			},
			allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
			allowHeaders: ['Content-Type', 'Authorization'],
		})
	);

	app.use('*', async (c, next) => {
		const { repositories } = await resolveAdminStorageContext(c.env);
		c.set('repositories', repositories);
		const principal = c.env.ADMIN_PRINCIPAL;
		if (!principal) {
			const rateLimited = await rejectRateLimitedAdminAuth(c.req.raw, c.env);
			if (rateLimited) return rateLimited;
			return c.json({ success: false, message: 'Unauthorized' }, 401);
		}
		c.set('principal', principal);
		await next();
	});

	app.use('/admin/*', async (c, next) => {
		const principal = c.get('principal');
		const decision = getAdminAuthorizationDecision(c.req.method, c.req.path);
		if (decision.kind === 'console_only') {
			if (principal.type !== 'console') {
				return c.json({ success: false, message: 'Forbidden', required_permission: 'console_session' }, 403);
			}
			return next();
		}
		if (decision.kind === 'authenticated') return next();
		if (decision.kind === 'deny') {
			return c.json({ success: false, message: 'Forbidden: admin route is not registered' }, 403);
		}
		if (!hasAdminPermission(principal, decision.permission)) {
			return c.json({ success: false, message: 'Forbidden', required_permission: decision.permission }, 403);
		}
		return next();
	});

	app.route('/admin/users', adminUsersRoutes);
	app.route('/admin/keys', adminKeysRoutes);
	app.route('/admin/providers', adminProvidersRoutes);
	app.route('/admin/models', adminModelsRoutes);
	app.route('/admin/routes', adminModelRoutes);
	app.route('/admin/endpoints', adminModelEndpointsRoutes);
	app.route('/admin/playground', adminPlaygroundRoutes);
	app.route('/admin/stats', adminStatsRoutes);
	app.route('/admin/config', adminConfigRoutes);
	app.route('/admin/request-logs', adminRequestLogsRoutes);
	app.route('/admin/budget-audit-logs', adminBudgetAuditLogsRoutes);
	app.route('/admin/business-timezone', adminBusinessTimezoneRoutes);
	app.route('/admin/analytics', adminAnalyticsRoutes);
	app.route('/admin/access-keys', adminAccessKeysRoutes);
	app.route('/admin/shared-keys', adminSharedKeysRoutes);
	app.route('/admin/withdrawals', adminWithdrawalsRoutes);
	app.route('/admin/earnings', adminEarningsRoutes);
	app.route('/admin/nft-mints', adminNftMintsRoutes);
	app.route('/admin/presets', adminPresetsRoutes);
	app.route('/admin/guardrails', adminGuardrailsRoutes);
	app.route('/admin/data-policies', adminDataPoliciesRoutes);

	app.get('/admin', (c) => c.json({ name: 'octafuse-admin-api', version: adminAppVersion }));

	return app;
}

let cached: ReturnType<typeof createAdminApp> | undefined;

export function getAdminApp(): Hono<AdminEnv> {
	if (!cached) {
		cached = createAdminApp();
	}
	return cached;
}
