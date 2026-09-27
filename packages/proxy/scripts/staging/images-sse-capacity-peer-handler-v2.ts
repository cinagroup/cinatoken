/// <reference path="./images-env.d.ts" />
import {createImagesSseCapacityStagingGateway} from './images-sse-capacity-gateway-handler';
import {SSE_HOST_EXPIRY_HEADER} from './images-sse-host-expiry-gateway-handler';
import {SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2';
import {parseSseSnapshotFault} from './images-sse-snapshot-fault-v2';
import {SSE_CANCEL_HEADER} from './images-sse-cancel-gateway-handler';
import {observeSseClientAbort} from './images-sse-cancel-observer';
import {withSseSnapshotHostExpiry} from './images-sse-host-expiry';
import {observeImagesSseCapacityPeerV2, SSE_CAPACITY_PEER_HEADER} from './images-sse-capacity-peer-observation-v2';

/** Opt-in peer profile. Financial logic and frozen host-expiry probes unchanged. */
export function createImagesSseCapacityPeerGatewayV2(transport: typeof fetch) {
  return observeImagesSseCapacityPeerV2(policy => {
    const handler = createImagesSseCapacityStagingGateway(transport, policy);
    return {
      async fetch(request, bindings, context) {
        const headers = new Headers(request.headers);
        headers.delete(SSE_CAPACITY_PEER_HEADER);
        const value = request.headers.get(SSE_HOST_EXPIRY_HEADER);
        if (value === null && !request.headers.has(SSE_SNAPSHOT_HEADER) && !request.headers.has(SSE_CANCEL_HEADER))
          return handler.fetch(new Request(request, {headers}), bindings, context);
        const probe = parseSseSnapshotFault(request.headers.get(SSE_SNAPSHOT_HEADER)), url = new URL(request.url);
        if (value !== 'v1' || request.headers.get(SSE_CANCEL_HEADER) !== 'v1'
          || !probe || !['before-hold', 'after-hold'].includes(probe.mode)
          || !bindings.DB || request.method !== 'POST' || url.pathname !== '/v1/images/generations'
          || url.search || url.hash || request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
          return new Response('Invalid staging SSE capacity peer host probe', {status: 400});
        for (const header of [SSE_HOST_EXPIRY_HEADER, SSE_SNAPSHOT_HEADER, SSE_CANCEL_HEADER]) headers.delete(header);
        const response = await handler.fetch(new Request(request, {headers}),
          {...bindings, DB: withSseSnapshotHostExpiry(bindings.DB, probe)}, context);
        observeSseClientAbort(request, response, bindings.DB, context, probe);
        return response;
      },
    };
  });
}
