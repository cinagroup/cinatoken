import postgres from 'postgres';
import { timingSafeEqual } from 'node:crypto';

const CLIENT_ID = 'cinatoken-admin';
const RESOURCE_ID = 'https://cinatoken.com';
const OUTPUT_KEYS = ['clientExists', 'clientDisabled', 'resourceExists', 'resourceDisabled', 'linkExists'];
const SELECT_METADATA = [
  'SELECT',
  'EXISTS (SELECT 1 FROM "oauthClient" WHERE "clientId" = $1) AS "clientExists",',
  'COALESCE((SELECT "disabled" FROM "oauthClient" WHERE "clientId" = $1), FALSE) AS "clientDisabled",',
  'EXISTS (SELECT 1 FROM "oauthResource" WHERE "identifier" = $2) AS "resourceExists",',
  'COALESCE((SELECT "disabled" FROM "oauthResource" WHERE "identifier" = $2), FALSE) AS "resourceDisabled",',
  'EXISTS (SELECT 1 FROM "oauthClientResource" WHERE "clientId" = $1 AND "resourceId" = $2) AS "linkExists"'
].join('\n');

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

function authorized(request, env) {
  const expected = env.REGISTRATION_PROBE_TOKEN;
  const supplied = request.headers.get('x-registration-probe-token');
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) return false;
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(expected), encoder.encode(supplied));
}

function sanitizedFailure(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : null;
  const classification = code === '42P01' ? 'relation_unavailable'
    : code === '42501' ? 'read_permission_denied'
    : code === '57014' ? 'query_timeout_or_canceled'
    : code ? 'database_read_failed' : 'probe_unavailable';
  return { classification, sqlstate: code };
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/registration-metadata') return json({ classification: 'not_found', sqlstate: null }, 404);
    if (request.method !== 'GET') return json({ classification: 'method_not_allowed', sqlstate: null }, 405);
    // The gate must succeed before the Hyperdrive binding or a SQL client is accessed.
    // Query parameters and the body are never read, and cannot select an identifier.
    if (!authorized(request, env)) return json({ classification: 'not_authorized', sqlstate: null }, 403);
    let sql;
    let result;
    let failure;
    try {
      sql = postgres(env.HYPERDRIVE.connectionString, {
        max: 1,
        prepare: false,
        fetch_types: false,
        connect_timeout: 5,
        idle_timeout: 1,
        max_lifetime: 15,
        debug: false,
        onnotice: () => {}
      });
      // postgres 3.4.9 emits BEGIN READ ONLY and COMMIT (or ROLLBACK on error)
      // on the reserved transaction connection. Exactly one SELECT is issued here.
      const rows = await sql.begin('read only', async transaction => {
        await transaction.unsafe('SET LOCAL statement_timeout = 5000');
        await transaction.unsafe('SET LOCAL lock_timeout = 2000');
        await transaction.unsafe('SET LOCAL idle_in_transaction_session_timeout = 7000');
        return transaction.unsafe(SELECT_METADATA, [CLIENT_ID, RESOURCE_ID]);
      });
      if (rows.length !== 1) throw new Error('Unexpected result shape');
      const row = rows[0];
      if (Object.keys(row).length !== OUTPUT_KEYS.length || OUTPUT_KEYS.some(key => typeof row[key] !== 'boolean')) throw new Error('Unexpected result shape');
      result = Object.fromEntries(OUTPUT_KEYS.map(key => [key, row[key]]));
    } catch (error) {
      failure = sanitizedFailure(error);
    } finally {
      if (sql) {
        try { await sql.end({ timeout: 2 }); }
        catch { failure = { classification: 'connection_cleanup_failed', sqlstate: null }; }
      }
    }
    return failure ? json(failure, 503) : json(result, 200);
  }
};
