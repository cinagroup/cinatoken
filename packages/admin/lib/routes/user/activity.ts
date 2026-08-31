import { Hono, type Context } from 'hono';
import type { UserEnv } from '@/lib/user-env';
import {
	exportUserActivityCsvService,
	listUserActivityService,
	type UserActivityQuery,
} from '@/lib/services/user/activity-service';

export const userActivityRoutes = new Hono<UserEnv>();

function activityQuery(c: Context<UserEnv>): UserActivityQuery {
	return {
		range: c.req.query('range'),
		page: c.req.query('page'),
		page_size: c.req.query('page_size'),
		api_key_id: c.req.query('api_key_id'),
		model_id: c.req.query('model_id'),
		status: c.req.query('status'),
	};
}

userActivityRoutes.get('/', async (c) => {
	const workspaceId = c.get('workspaceContext').currentWorkspace.id;
	const result = await listUserActivityService(
		c.get('repositories'),
		c.get('principal').userId,
		workspaceId,
		activityQuery(c),
	);
	if (!result) return c.json({ success: false, message: 'Account not found' }, 404);
	c.header('Cache-Control', 'private, no-store');
	return c.json({ success: true, data: result });
});

userActivityRoutes.get('/export.csv', async (c) => {
	const workspaceId = c.get('workspaceContext').currentWorkspace.id;
	const result = await exportUserActivityCsvService(
		c.get('repositories'),
		c.get('principal').userId,
		workspaceId,
		activityQuery(c),
	);
	if (!result) return c.json({ success: false, message: 'Account not found' }, 404);
	const date = new Date().toISOString().slice(0, 10);
	return c.body(result.csv, 200, {
		'Cache-Control': 'private, no-store',
		'Content-Type': 'text/csv; charset=utf-8',
		'Content-Disposition': `attachment; filename="cinatoken-activity-${date}.csv"`,
		'X-CinaToken-Export-Count': String(result.rowCount),
		'X-CinaToken-Export-Total': String(result.total),
		'X-CinaToken-Export-Truncated': String(result.truncated),
		'X-CinaToken-Billing-Currency': result.billingCurrency,
	});
});
