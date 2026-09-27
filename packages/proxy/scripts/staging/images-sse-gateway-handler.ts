import { createWorkerHandler } from '../../src/runtime/worker-handler';
import { UPSTREAM_ORIGIN, UPSTREAM_PATH } from './images-upstream';
import { IMAGE_SSE_PATH } from './images-sse-probe-contract';

export function privateImageSseTransport(transport: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== UPSTREAM_ORIGIN || url.search || url.hash || url.username || url.password
      || !(UPSTREAM_PATH.test(url.pathname) || url.pathname === IMAGE_SSE_PATH)
      || init?.method !== 'POST' || init.redirect !== 'manual') throw new Error('Unexpected SSE fixture destination');
    return transport(input, init);
  };
}
export function createImagesSseStagingGateway(transport: typeof fetch) {
  return createWorkerHandler({ imageFetch: privateImageSseTransport(transport),
    imageUsageRecovery: { settlementLeaseSeconds: 30 } });
}
