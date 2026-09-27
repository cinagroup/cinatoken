import {createWorkerHandler} from '../../src/runtime/worker-handler';
import type {HttpRequestCapacityPolicy} from '../../src/middleware/request-capacity';
import {privateImageSseTransport} from './images-sse-gateway-handler';

/** Isolated composition for lifecycle verification, not a production memory recommendation.
 * Caller supplies one shared numeric pool for the selected Worker instance, never per request.
 * No observation route, request-configured limit, alternate transport or automatic activation.
 */
export function createImagesSseCapacityStagingGateway(transport: typeof fetch, httpCapacity: HttpRequestCapacityPolicy) {
  return createWorkerHandler({imageFetch:privateImageSseTransport(transport),httpCapacity,
    imageUsageRecovery:{settlementLeaseSeconds:30,streaming:true}});
}
