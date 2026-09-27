/// <reference path="./images-env.d.ts" />
import { createImagesSseDurableStagingGateway } from './images-sse-durable-gateway-handler';
import { parseSseSnapshotFault, withSseSnapshotFault } from './images-sse-snapshot-fault';

export const SSE_SNAPSHOT_HEADER = 'x-c02-sse-snapshot';
/** Independent staging composition. Header selects a probe, never grants tenant/API-key authorization. */
export function createImagesSseSnapshotStagingGateway(transport: typeof fetch) {
  const handler = createImagesSseDurableStagingGateway(transport);
  return {
    ...handler,
    fetch(request, bindings, context) {
      const value = request.headers.get(SSE_SNAPSHOT_HEADER);
      if (value === null) return handler.fetch(request, bindings, context);
      const probe = parseSseSnapshotFault(value), url = new URL(request.url);
      if (!probe || !bindings.DB || bindings.DATABASE_DRIVER !== 'd1' || request.method !== 'POST'
        || url.pathname !== '/v1/images/generations' || url.search || url.hash
        || request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('Invalid staging SSE snapshot probe', { status: 400 });
      }
      // Preserve body streaming and request signal; no clone().json() or secondary body consumer.
      const headers = new Headers(request.headers); headers.delete(SSE_SNAPSHOT_HEADER);
      return handler.fetch(new Request(request, { headers }),
        { ...bindings, DB: withSseSnapshotFault(bindings.DB, probe) }, context);
    },
  } satisfies ExportedHandler<ImagesStagingEnv>;
}
