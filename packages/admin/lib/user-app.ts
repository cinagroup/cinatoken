/**
 * 用户门户 API Hono 子应用：内部路由为 `/user/*`；由 Next 对外暴露为 `/api/user/*`。
 * 与管理台 `/admin/*` 共享存储绑定但会话/权限完全独立（`user_session`）。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { StorageContext } from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';
import { resolveAdminStorageContext } from '@/lib/storage-context';
import { adminAppVersion as appVersion } from '@/lib/app-version';
import { getUserSessionToken, USER_SESSION_COOKIE } from '@/lib/user-auth';
import { userSharedKeysRoutes } from '@/lib/routes/user/shared-keys';
import { userEarningsRoutes } from '@/lib/routes/user/earnings';
import { userWalletRoutes } from '@/lib/routes/user/wallet';
import { userWithdrawalsRoutes } from '@/lib/routes/user/withdrawals';
import { userNftRoutes } from '@/lib/routes/user/nft';
import { userGatewayKeysRoutes } from '@/lib/routes/user/gateway-keys';

export function createUserApp(): Hono<UserEnv> {
	const app = new Hono<UserEnv>();

	app.use('*', logger());
	app.use(
		'*',
		cors({
			origin: '*',
			allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
			allowHeaders: ['Content-Type', 'Authorization'],
		})
	);

	app.use('*', async (c, next) => {
		const { repositories } = await resolveAdminStorageContext(c.env);
		c.set('repositories', repositories);
		const principal = c.env.USER_PRINCIPAL;
		if (!principal) return c.json({ success: false, message: 'Unauthorized' }, 401);
		c.set('principal', principal);
		await next();
	});

	app.get('/user/me', (c) => {
		const principal = c.get('principal');
		return c.json({
			success: true,
			user: {
				userId: principal.userId,
				subject: principal.subject,
				email: principal.email,
			},
		});
	});

	app.post('/user/auth/logout', async (c) => {
		const repositories = c.get('repositories');
		const token = getUserSessionToken(c.req.raw);
		if (token) {
			const { hashSessionToken } = await import('@/lib/auth');
			await repositories.portalAccess.deleteSession(await hashSessionToken(token));
		}
		c.header(
			'Set-Cookie',
			`${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
		);
		return c.json({ success: true });
	});

	app.route('/user/shared-keys', userSharedKeysRoutes);
	app.route('/user/earnings', userEarningsRoutes);
	app.route('/user/wallet', userWalletRoutes);
	app.route('/user/withdrawals', userWithdrawalsRoutes);
	app.route('/user/nft', userNftRoutes);
	app.route('/user/gateway-keys', userGatewayKeysRoutes);

	app.get('/user', (c) => c.json({ name: 'cinatoken-user-api', version: appVersion }));

	return app;
}

let cached: ReturnType<typeof createUserApp> | undefined;

export function getUserApp(): Hono<UserEnv> {
	if (!cached) {
		cached = createUserApp();
	}
	return cached;
}
