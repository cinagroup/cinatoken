import type { MiddlewareHandler } from 'hono';
import type { Env } from '../app';
import { scheduleBackgroundWork } from '../runtime/schedule-background-work';
import { capacityResponseBody } from '../services/capacity-response-body';
import { assertCapacityInteger, type RequestCapacityPool } from '../services/request-capacity';
import { GatewayErrorCode } from '../services/gateway-error-codes';
import { gatewayErrorJson } from '../services/gateway-error-response';

/**
 * Explicit opt-in only. No production memory profile is implied by these numbers.
 * All HTTP methods/routes share a fixed worst-case reservation; client headers,
 * content length, model selection and route aliases cannot lower the charge.
 * Upgrade protocols require their own host/session ownership and are denied.
 */
export type HttpRequestCapacityPolicy = {
	readonly pool: RequestCapacityPool;
	readonly reservedBytesPerRequest: number;
};

export function requestCapacityMiddleware(policy: HttpRequestCapacityPolicy): MiddlewareHandler<Env> {
	const { pool, reservedBytesPerRequest } = policy;
	assertCapacityInteger(reservedBytesPerRequest);
	if (reservedBytesPerRequest > pool.snapshot().maxReservedBytes) {
		throw new RangeError('HTTP request reservation exceeds the capacity pool');
	}
	return async (c, next) => {
		// Never let an Upgrade header turn a regular HTTP route into a capacity bypass.
		const unsupported = c.req.header('upgrade') !== undefined || c.env?.NODE_REALTIME_DISPATCH !== undefined;
		const lease = unsupported ? null : pool.tryAcquire(reservedBytesPerRequest);
		if (!lease) return gatewayErrorJson(c, {
			status: 503, code: GatewayErrorCode.capacityUnavailable,
			message: 'Gateway capacity is unavailable',
			headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-OctaFuse-Error-Code' },
		});
		c.set('requestCapacityLease', lease);
		try {
			// Await the whole handler chain, including owned preparation writes.
			// Client abort does not release this owner while that work is still live.
			await next();
			if (c.res.body) {
				const body = capacityResponseBody(c.res.body, lease, c.req.raw.signal,
					(task) => scheduleBackgroundWork(c, task));
				// Hono executes the GET handler for HEAD, then discards its body.
				// Explicit cancellation is necessary; there will be no consumer EOF.
				if (c.req.method === 'HEAD') {
					void body.cancel().catch(() => undefined);
					c.res = new Response(null, c.res);
				} else try { c.res = new Response(body, c.res); }
				catch (error) { void body.cancel().catch(() => undefined); throw error; }
			}
		} finally { lease.release(); }
	};
}
