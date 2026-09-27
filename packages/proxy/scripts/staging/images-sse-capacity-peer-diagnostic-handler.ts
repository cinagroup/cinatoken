/// <reference path="./images-env.d.ts" />
import {SSE_CAPACITY_ORIGIN, SSE_CAPACITY_PATH, SSE_CAPACITY_INSTANCE_HEADER} from './images-sse-capacity-observation';
import {SSE_PEER_V3_PATH} from './images-sse-capacity-peer-observation-v3';
import {createImagesSseCapacityPeerGatewayV3} from './images-sse-capacity-peer-handler-v3';

export const SSE_PEER_DIAGNOSTIC_HEADER = 'x-c02-peer-diagnostic';
export const SSE_PEER_OBSERVED_INSTANCE_HEADER = 'x-c02-peer-observed-instance';
export const SSE_PEER_DIAGNOSTIC_VERSION = 'instance-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Handler = Pick<Required<ExportedHandler<ImagesStagingEnv>>, 'fetch'>;

/** Diagnostics only, around the unchanged V3 handler and its SAME module pool.
 * An internal census reads only its stable UUID; no external call, SQL, lease,
 * body reader, timer, new background work or request-scoped global state.
 * The observer must first prove the original canonical complete mismatch body.
 * UUID equality alone is neither capacity/native proof nor retry authority.
 */
export function withSsePeerV3InstanceDiagnostic(handler: Handler): Handler {
  return {
    async fetch(request, bindings, context) {
      // Private output fields must never be reflected or forwarded upstream.
      if (request.headers.has(SSE_PEER_DIAGNOSTIC_HEADER) || request.headers.has(SSE_PEER_OBSERVED_INSTANCE_HEADER))
        return Response.json({status:'rejected',reason:'diagnostic_input_unavailable',dispatch_started:false}, {status:400,headers:{'Cache-Control':'no-store'}});
      const response = await handler.fetch(request, bindings, context);
      const url = new URL(request.url);
      if (url.origin !== SSE_CAPACITY_ORIGIN || url.pathname !== SSE_PEER_V3_PATH || url.search || url.hash
        || request.method !== 'GET' || response.status !== 409)
        return response; // Original success/101/other rejection remains untouched.
      // Census and rejection come from the same composed handler, not from a
      // new request routed through Cloudflare. Its UUID never changes in-place.
      const census = await handler.fetch(new Request(SSE_CAPACITY_ORIGIN + SSE_CAPACITY_PATH), bindings, context);
      const instance = census.headers.get(SSE_CAPACITY_INSTANCE_HEADER);
      await census.body?.cancel();
      if (census.status !== 200 || instance === null || instance.length !== 36 || !uuid.test(instance)) return response;
      const headers = new Headers(response.headers);
      headers.set(SSE_PEER_DIAGNOSTIC_HEADER, SSE_PEER_DIAGNOSTIC_VERSION);
      headers.set(SSE_PEER_OBSERVED_INSTANCE_HEADER, instance);
      // Preserve exact status and original body, without reading, cloning or
      // teeing it. Never reconstruct a successful WebSocket upgrade here.
      return new Response(response.body, {status:response.status,statusText:response.statusText,headers});
    },
  };
}

export function createImagesSsePeerDiagnosticGateway(transport: typeof fetch): Handler {
  return withSsePeerV3InstanceDiagnostic(createImagesSseCapacityPeerGatewayV3(transport));
}
