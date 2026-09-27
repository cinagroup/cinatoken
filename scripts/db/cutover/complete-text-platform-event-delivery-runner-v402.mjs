import {
  scanPostgresCompleteTextPlatformEventsV402,
  claimPostgresCompleteTextPlatformEventsV402,
  finishPostgresCompleteTextPlatformPublishV402,
  consumePostgresCompleteTextPlatformEventV402,
} from './postgres-complete-text-platform-event-delivery-v402.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const defaults = Object.freeze({ scan: scanPostgresCompleteTextPlatformEventsV402,
  claim: claimPostgresCompleteTextPlatformEventsV402, finish: finishPostgresCompleteTextPlatformPublishV402,
  consume: consumePostgresCompleteTextPlatformEventV402 });
function invalid() { throw new TypeError('Platform event delivery runner contract invalid'); }

/** Broker acceptance schedules visibility expiry; only consumer receipt means delivered. */
export async function publishCompleteTextPlatformEventsV402(params, ports = defaults) {
  const connectionString = params?.connectionString, limit = params?.limit, leaseNonce = params?.leaseNonce;
  const queue = params?.queue, send = queue?.send;
  const scanPort = ports?.scan, claimPort = ports?.claim, finishPort = ports?.finish;
  if (typeof connectionString !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20
    || typeof leaseNonce !== 'string' || !UUID.test(leaseNonce) || typeof send !== 'function'
    || typeof scanPort !== 'function' || typeof claimPort !== 'function' || typeof finishPort !== 'function') invalid();
  const sendOwned = send.bind(queue);
  const scan = await scanPort({ connectionString, limit });
  const claim = await claimPort({ connectionString, limit, leaseNonce });
  if (claim?.status !== 'claimed' || claim.leaseNonce !== leaseNonce || !Array.isArray(claim.items)
    || claim.items.length > limit) invalid();
  const publications = [], ids = new Set(), claimedIds = [];
  for (const item of claim.items) {
    if (typeof item?.eventId !== 'string' || !UUID.test(item.eventId) || ids.has(item.eventId)) invalid();
    ids.add(item.eventId);
    claimedIds.push(item.eventId);
  }
  for (const eventId of claimedIds) {
    let outcome = 'published';
    try {
      const publication = sendOwned(eventId);
      if (!publication || typeof publication.then !== 'function') throw new Error('Broker publish did not acknowledge');
      await publication;
    } catch { outcome = 'failed'; }
    // Unknown broker acceptance may redeliver. Unknown SQL outcome stops this invocation.
    const receipt = await finishPort({ connectionString, eventId, leaseNonce, outcome });
    publications.push(Object.freeze({ eventId, outcome, receipt }));
  }
  return Object.freeze({ scan, claim, publications: Object.freeze(publications) });
}

/** No message ACK escapes before the actual consumption COMMIT and LOGIN close. */
export async function consumeCompleteTextPlatformMessageV402(params, ports = defaults) {
  const connectionString = params?.connectionString, message = params?.message;
  const eventId = message?.body, ack = message?.ack, consume = ports?.consume;
  if (typeof connectionString !== 'string' || typeof eventId !== 'string' || !UUID.test(eventId)
    || typeof ack !== 'function' || typeof consume !== 'function') invalid();
  const ackOwned = ack.bind(message);
  const receipt = await consume({ connectionString, eventId });
  if (!receipt || !['consumed', 'already_consumed'].includes(receipt.status) || receipt.eventId !== eventId) invalid();
  await ackOwned();
  return receipt;
}
