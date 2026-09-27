import {createWorkerHandler} from '../../src/runtime/worker-handler';
import {privateImageSseTransport} from './images-sse-gateway-handler';

/** Explicit isolated candidate; not an automatic production or old staging default. */
export function createImagesSseDurableStagingGateway(transport: typeof fetch) {
  return createWorkerHandler({imageFetch:privateImageSseTransport(transport),
    imageUsageRecovery:{settlementLeaseSeconds:30,streaming:true}});
}
