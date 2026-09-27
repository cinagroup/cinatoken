import postgres from 'postgres';

export const PLATFORM_EVENT_PUBLISHER_V402 = 'cinatoken_gateway_complete_text_platform_event_publisher';
export const PLATFORM_EVENT_CONSUMER_V402 = 'cinatoken_gateway_complete_text_platform_event_consumer';
const OPERATOR = 'cinatoken_gateway_migrator';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const open = connection => postgres(connection, { max: 1, prepare: false,
  fetch_types: false, connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false });

export class PostgresPlatformEventCleanupUnconfirmedV402 extends Error {
  constructor(cause) {
    super('PostgreSQL platform event LOGIN cleanup unconfirmed', { cause });
    this.name = 'PostgresPlatformEventCleanupUnconfirmedV402';
  }
}
function invalid() { throw new TypeError('PostgreSQL platform event contract invalid'); }
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function keys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/u.test(value)
    && Number.isFinite(Date.parse(value));
}
function frozenCopy(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = child => {
    if (child && typeof child === 'object') {
      for (const member of Object.values(child)) freeze(member);
      Object.freeze(child);
    }
  };
  freeze(copy);
  return copy;
}
function connectionFor(connection, roles) {
  let url;
  try { url = new URL(connection); } catch { return invalid(); }
  if (typeof connection !== 'string' || connection !== connection.trim()
    || !['postgres:', 'postgresql:'].includes(url.protocol)
    || !roles.includes(decodeURIComponent(url.username)) || !url.hostname || !url.password
    || !url.pathname || url.pathname === '/' || url.hash
    || [...url.searchParams].length > 1 || [...url.searchParams].some(([key, value]) =>
      key.toLowerCase() !== 'sslmode' || !['disable', 'require'].includes(value))) invalid();
  return decodeURIComponent(url.username);
}
function receipt(value, withStatus, eventId) {
  const fields = ['eventId', 'terminalId', 'requestId', 'eventType', 'eventVersion', 'payloadSha256', 'consumedAt'];
  if (withStatus) fields.push('status');
  if (!keys(value, fields) || value.eventId !== eventId || !uuid(value.eventId)
    || !uuid(value.terminalId) || typeof value.requestId !== 'string' || value.requestId.length === 0
    || encoder.encode(value.requestId).length > 512
    || value.eventType !== 'platform_text_no_fetch_closed' || value.eventVersion !== 1
    || typeof value.payloadSha256 !== 'string' || !HASH.test(value.payloadSha256)
    || !timestamp(value.consumedAt)
    || (withStatus && !['consumed', 'already_consumed'].includes(value.status))) invalid();
  return value;
}

/** Each operation owns one LOGIN transaction, COMMIT and connection close. */
async function operation(connection, roles, query, args, parse, factory) {
  const role = connectionFor(connection, roles);
  if (typeof factory !== 'function') invalid();
  const sql = factory(connection, { max: 1 });
  let result, failure, failed = false;
  try {
    result = await sql.begin(async tx => {
      const login = await tx.unsafe(`SELECT current_user AS current_role, session_user AS session_role,
        pg_catalog.current_setting('transaction_isolation') AS transaction_isolation`);
      if (login.length !== 1 || login[0]?.current_role !== role || login[0]?.session_role !== role
        || login[0]?.transaction_isolation !== 'read committed') invalid();
      await tx.unsafe("SET LOCAL lock_timeout='2s'");
      await tx.unsafe("SET LOCAL statement_timeout='15s'");
      const rows = await tx.unsafe(query, args);
      if (rows.length !== 1 || !keys(rows[0], ['value'])) invalid();
      return frozenCopy(parse(rows[0].value));
    });
  } catch (error) { failed = true; failure = error; }
  try {
    const closing = sql.end({ timeout: 1 });
    if (!closing || typeof closing.then !== 'function') throw new Error('Platform event LOGIN close did not acknowledge');
    await closing;
  } catch (error) {
    throw new PostgresPlatformEventCleanupUnconfirmedV402(failed
      ? new AggregateError([failure, error], 'Platform event operation and LOGIN cleanup failed') : error);
  }
  if (failed) throw failure;
  if (result === undefined) invalid();
  return result;
}

export function scanPostgresCompleteTextPlatformEventsV402(params, factory = open) {
  const connection = params?.connectionString, limit = params?.limit;
  if (!integer(limit, 1, 20)) invalid();
  return operation(connection, [PLATFORM_EVENT_PUBLISHER_V402],
    'SELECT cinatoken_gateway.scan_complete_text_platform_events_v402($1::integer) AS value', [limit], value => {
      if (!keys(value, ['status', 'enqueued']) || value.status !== 'scanned' || !integer(value.enqueued, 0, limit)) invalid();
      return value;
    }, factory);
}
export function claimPostgresCompleteTextPlatformEventsV402(params, factory = open) {
  const connection = params?.connectionString, limit = params?.limit, nonce = params?.leaseNonce;
  if (!integer(limit, 1, 20) || !uuid(nonce)) invalid();
  return operation(connection, [PLATFORM_EVENT_PUBLISHER_V402],
    'SELECT cinatoken_gateway.claim_complete_text_platform_events_v402($1::integer,$2::uuid) AS value', [limit, nonce], value => {
      if (!keys(value, ['status', 'leaseNonce', 'items']) || value.status !== 'claimed'
        || value.leaseNonce !== nonce || !Array.isArray(value.items) || value.items.length > limit) invalid();
      const ids = new Set();
      for (const item of value.items) {
        if (!keys(item, ['eventId', 'attemptCount', 'leaseUntil']) || !uuid(item.eventId)
          || !integer(item.attemptCount, 1, 7) || !timestamp(item.leaseUntil) || ids.has(item.eventId)) invalid();
        ids.add(item.eventId);
      }
      return value;
    }, factory);
}
export function finishPostgresCompleteTextPlatformPublishV402(params, factory = open) {
  const connection = params?.connectionString, eventId = params?.eventId;
  const nonce = params?.leaseNonce, outcome = params?.outcome;
  if (!uuid(eventId) || !uuid(nonce) || !['published', 'failed'].includes(outcome)) invalid();
  return operation(connection, [PLATFORM_EVENT_PUBLISHER_V402],
    'SELECT cinatoken_gateway.finish_complete_text_platform_publish_v402($1::uuid,$2::uuid,$3::text) AS value',
    [eventId, nonce, outcome], value => {
      if (!keys(value, ['status', 'eventId', 'attemptCount']) || value.eventId !== eventId
        || !['published', 'retry_scheduled', 'dead_letter', 'already_consumed', 'lease_lost'].includes(value.status)
        || !integer(value.attemptCount, 0, 7)) invalid();
      if ((value.status === 'published' && (outcome !== 'published' || value.attemptCount < 1))
        || (value.status === 'retry_scheduled' && (outcome !== 'failed' || !integer(value.attemptCount, 1, 6)))
        || (value.status === 'dead_letter' && (outcome !== 'failed' || value.attemptCount !== 7))) invalid();
      return value;
    }, factory);
}
export function consumePostgresCompleteTextPlatformEventV402(params, factory = open) {
  const connection = params?.connectionString, eventId = params?.eventId;
  if (!uuid(eventId)) invalid();
  return operation(connection, [PLATFORM_EVENT_CONSUMER_V402],
    'SELECT cinatoken_gateway.consume_complete_text_platform_event_v402($1::uuid) AS value', [eventId],
    value => receipt(value, true, eventId), factory);
}
export function observePostgresCompleteTextPlatformEventV402(params, factory = open) {
  const connection = params?.connectionString, eventId = params?.eventId;
  if (!uuid(eventId)) invalid();
  return operation(connection, [PLATFORM_EVENT_PUBLISHER_V402, PLATFORM_EVENT_CONSUMER_V402],
    'SELECT cinatoken_gateway.observe_complete_text_platform_event_v402($1::uuid) AS value', [eventId], value => {
      if (!keys(value, ['status', 'eventId', 'receipt', 'job']) || value.eventId !== eventId
        || !['consumed', 'pending', 'missing'].includes(value.status)) invalid();
      if (value.receipt !== null) receipt(value.receipt, false, eventId);
      if ((value.status === 'consumed') !== (value.receipt !== null)
        || (value.status === 'missing' && value.job !== null)) invalid();
      if (value.job !== null) {
        const job = value.job;
        if (!keys(job, ['status', 'attemptCount', 'nextAttemptAt', 'leaseNonce', 'leaseUntil'])
          || !['pending', 'publishing', 'published', 'delivered', 'dead_letter'].includes(job.status)
          || !integer(job.attemptCount, 0, 7) || !timestamp(job.nextAttemptAt)
          || (job.leaseNonce !== null && !uuid(job.leaseNonce))
          || (job.leaseUntil !== null && !timestamp(job.leaseUntil))
          || ((job.leaseNonce === null) !== (job.leaseUntil === null))) invalid();
        const leased = ['publishing', 'published'].includes(job.status);
        if (leased !== (job.leaseNonce !== null) || (leased && job.attemptCount < 1)
          || (job.status === 'dead_letter' && job.attemptCount !== 7)
          || (leased && job.nextAttemptAt !== job.leaseUntil)
          || (value.status === 'consumed' && job.status !== 'delivered')
          || (job.status === 'delivered' && value.status !== 'consumed')) invalid();
      }
      return value;
    }, factory);
}
/** Operator restore is a separate migrator LOGIN, never a publisher port. */
export function requeuePostgresCompleteTextPlatformEventV402(params, factory = open) {
  const connection = params?.connectionString, eventId = params?.eventId, reason = params?.reason;
  if (params?.operatorLogin !== OPERATOR || !uuid(eventId) || typeof reason !== 'string'
    || reason.length === 0 || reason !== reason.trim() || /\p{Cc}/u.test(reason)
    || encoder.encode(reason).length > 256) invalid();
  return operation(connection, [OPERATOR],
    'SELECT cinatoken_gateway.requeue_complete_text_platform_event_v402($1::uuid,$2::text) AS value', [eventId, reason], value => {
      if (!keys(value, ['status', 'eventId', 'restoreCount']) || value.eventId !== eventId
        || !['requeued', 'already_consumed'].includes(value.status)
        || !integer(value.restoreCount, value.status === 'requeued' ? 1 : 0, 3)) invalid();
      return value;
    }, factory);
}
