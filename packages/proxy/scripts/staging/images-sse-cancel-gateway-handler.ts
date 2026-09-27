/// <reference path="./images-env.d.ts" />
import {createImagesSseSnapshotStagingGateway, SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2';
import {parseSseSnapshotFault} from './images-sse-snapshot-fault-v2';
import {observeSseClientAbort} from './images-sse-cancel-observer';

export const SSE_CANCEL_HEADER = 'x-c02-sse-cancel-observe';
export function createImagesSseCancelStagingGateway(transport: typeof fetch) {
  const handler = createImagesSseSnapshotStagingGateway(transport);
  return {
    ...handler,
    async fetch(request, bindings, context) {
      const value = request.headers.get(SSE_CANCEL_HEADER);
      if (value === null) return handler.fetch(request, bindings, context);
      const probe = parseSseSnapshotFault(request.headers.get(SSE_SNAPSHOT_HEADER));
      if (value !== 'v1' || !probe || !['before-hold', 'after-hold'].includes(probe.mode)
        || !bindings.DB || bindings.DATABASE_DRIVER !== 'd1') {
        return new Response('Invalid staging SSE cancellation observation', {status: 400});
      }
      const headers = new Headers(request.headers); headers.delete(SSE_CANCEL_HEADER);
      // The underlying handler still owns method/path/content-type and API-key authorization.
      const response = await handler.fetch(new Request(request, {headers}), bindings, context);
      if (response) observeSseClientAbort(request, response, bindings.DB, context, probe);
      return response;
    },
  } satisfies ExportedHandler<ImagesStagingEnv>;
}
