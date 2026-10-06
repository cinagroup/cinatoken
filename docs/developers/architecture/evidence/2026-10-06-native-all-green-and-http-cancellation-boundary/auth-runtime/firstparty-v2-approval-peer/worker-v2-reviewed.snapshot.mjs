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
  const classification = error?.message === 'registration_policy_blocked' ? 'registration_policy_blocked'
    : error?.message === 'registration_link_not_created' ? 'registration_link_not_created'
    : code === '42P01' ? 'relation_unavailable'
    : code === '42501' ? 'read_permission_denied'
    : code === '57014' ? 'query_timeout_or_canceled'
    : code ? 'database_read_failed' : 'probe_unavailable';
  return { classification, sqlstate: code };
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/registration-link-repair') return json({ classification: 'not_found', sqlstate: null }, 404);
    if (request.method !== 'POST') return json({ classification: 'method_not_allowed', sqlstate: null }, 405);
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
      // Lock the already-existing fixed client/resource and preserve both policies.
      // This transaction may INSERT only their missing exact association.
      result = await sql.begin(async transaction => {
        await transaction.unsafe('SET LOCAL statement_timeout = 5000');
        await transaction.unsafe('SET LOCAL lock_timeout = 2000');
        await transaction.unsafe('SET LOCAL idle_in_transaction_session_timeout = 7000');
        const client = await transaction.unsafe('SELECT COALESCE("disabled", FALSE) AS "disabled" FROM "oauthClient" WHERE "clientId" = $1 FOR UPDATE', [CLIENT_ID]);
        const resource = await transaction.unsafe('SELECT COALESCE("disabled", FALSE) AS "disabled" FROM "oauthResource" WHERE "identifier" = $1 FOR UPDATE', [RESOURCE_ID]);
        const readMetadata = async () => {
          const rows = await transaction.unsafe(SELECT_METADATA, [CLIENT_ID, RESOURCE_ID]);
          if (rows.length !== 1 || Object.keys(rows[0]).length !== OUTPUT_KEYS.length || OUTPUT_KEYS.some(key => typeof rows[0][key] !== 'boolean')) throw new Error('Unexpected result shape');
          return Object.fromEntries(OUTPUT_KEYS.map(key => [key, rows[0][key]]));
        };
        const before = await readMetadata();
        if (client.length !== 1 || resource.length !== 1 || client[0].disabled !== false || resource[0].disabled !== false || !before.clientExists || before.clientDisabled || !before.resourceExists || before.resourceDisabled) throw new Error('registration_policy_blocked');
        const inserted = await transaction.unsafe('INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING RETURNING TRUE AS "inserted"', [CLIENT_ID + ':' + RESOURCE_ID, CLIENT_ID, RESOURCE_ID]);
        const after = await readMetadata();
        if (!after.clientExists || !after.resourceExists || !after.linkExists || after.clientDisabled || after.resourceDisabled) throw new Error('registration_link_not_created');
        return { before, after, insertedClientLink: inserted.length === 1 };
      });
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
