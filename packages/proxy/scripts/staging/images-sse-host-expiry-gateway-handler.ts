/// <reference path="./images-env.d.ts" />
import {createImagesSseDurableStagingGateway} from './images-sse-durable-gateway-handler';
import {SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2';
import {parseSseSnapshotFault} from './images-sse-snapshot-fault-v2';
import {SSE_CANCEL_HEADER} from './images-sse-cancel-gateway-handler';
import {observeSseClientAbort} from './images-sse-cancel-observer';
import {withSseSnapshotHostExpiry} from './images-sse-host-expiry';

export const SSE_HOST_EXPIRY_HEADER = 'x-c02-sse-host-expiry';
/** Only this independent staging entry enables the fixed profile; no production option. */
export function createImagesSseHostExpiryGateway(transport: typeof fetch) {
  const handler = createImagesSseDurableStagingGateway(transport);
  return {
    ...handler,
    async fetch(request, bindings, context) {
      const value = request.headers.get(SSE_HOST_EXPIRY_HEADER);
      if (value === null && !request.headers.has(SSE_SNAPSHOT_HEADER) && !request.headers.has(SSE_CANCEL_HEADER))
        return handler.fetch(request, bindings, context);
      const probe = parseSseSnapshotFault(request.headers.get(SSE_SNAPSHOT_HEADER)), url = new URL(request.url);
      if (value !== 'v1' || request.headers.get(SSE_CANCEL_HEADER) !== 'v1'
        || !probe || !['before-hold', 'after-hold'].includes(probe.mode)
        || !bindings.DB || bindings.DATABASE_DRIVER !== 'd1' || request.method !== 'POST'
        || url.pathname !== '/v1/images/generations' || url.search || url.hash
        || request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('Invalid staging SSE host expiry probe', {status: 400});
      }
      const headers = new Headers(request.headers);
      for (const header of [SSE_HOST_EXPIRY_HEADER, SSE_SNAPSHOT_HEADER, SSE_CANCEL_HEADER]) headers.delete(header);
      const response = await handler.fetch(new Request(request, {headers}),
        {...bindings, DB: withSseSnapshotHostExpiry(bindings.DB, probe)}, context);
      // Observe the original client signal via the native binding, not the paused facade.
      if (response) observeSseClientAbort(request, response, bindings.DB, context, probe);
      return response;
    },
  } satisfies ExportedHandler<ImagesStagingEnv>;
}
