/// <reference path="./images-env.d.ts" />
import {createRequestCapacityPool} from '../../src/services/request-capacity';
import type {HttpRequestCapacityPolicy} from '../../src/middleware/request-capacity';

export const SSE_CAPACITY_ORIGIN = 'https://cinatoken-proxy-staging.cinagroup.workers.dev';
export const SSE_CAPACITY_PATH = '/__staging/sse-capacity';
export const SSE_CAPACITY_INSTANCE_HEADER = 'x-c02-capacity-instance';
export const SSE_CAPACITY_PROFILE = 'c02-sse-ownership-v1';
// Arbitrary logical test reservation. Never a physical memory recommendation.
export const SSE_CAPACITY_BYTES = 1024;
type Handler = Pick<Required<ExportedHandler<ImagesStagingEnv>>, 'fetch'>;

/** One pool and one random identity per composed module instance, not per request.
 * Retains only numerical counters and an instance UUID. The fixed census is an
 * intentional read-only admission bypass behind staging Access, so a saturated
 * instance remains observable. No reset, lease TTL, DB call or body read.
 */
export function observeImagesSseCapacity(build: (policy: HttpRequestCapacityPolicy) => Handler): Handler {
  const pool = createRequestCapacityPool({maxRequests: 1, maxReservedBytes: SSE_CAPACITY_BYTES});
  const handler = build(Object.freeze({pool, reservedBytesPerRequest: SSE_CAPACITY_BYTES}));
  let instanceId: string | undefined;
  return {
    async fetch(request, bindings, context) {
      const url = new URL(request.url);
      // Public production/custom domains and alternate environments are not this profile.
      if (url.origin !== SSE_CAPACITY_ORIGIN || bindings.DATABASE_DRIVER !== 'd1'
        || bindings.REQUEST_BODY_LOGGING !== 'off' || bindings.BATCH_API_ENABLED !== 'false')
        return new Response('Staging capacity profile unavailable', {status: 404});
      const id = instanceId ??= crypto.randomUUID();
      if (url.pathname === SSE_CAPACITY_PATH) {
        if (request.method !== 'GET' || url.search || url.hash || request.headers.has('upgrade'))
          return new Response('Invalid staging capacity observation', {status: 400});
        return Response.json({profile: SSE_CAPACITY_PROFILE, instanceId: id, ...pool.snapshot()}, {
          headers: {'Cache-Control': 'no-store', [SSE_CAPACITY_INSTANCE_HEADER]: id},
        });
      }
      const response = await handler.fetch(request, bindings, context);
      const headers = new Headers(response.headers);
      // Never reflect a client identity. Rewrap without reading, teeing or buffering.
      headers.set(SSE_CAPACITY_INSTANCE_HEADER, id);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
    },
  };
}
