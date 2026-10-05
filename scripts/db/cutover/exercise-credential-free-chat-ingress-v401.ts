import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createPostgresStorageContext, type GatewayRepositories, type PostgresDatabaseClient, type StorageContext } from '@octafuse/core';
import { createProxyApp, type GatewayBindings } from '../../../packages/proxy/src/app';
import type { CredentialFreeChatIngressCompositionV401 } from '../../../packages/proxy/src/services/credential-free-chat-ingress-v401';
import { readPostgresCompleteTextRoutingProjectionV396 } from '../../../packages/proxy/src/services/postgres-complete-text-routing-projection-v396';
import { createRequestCapacityPool } from '../../../packages/proxy/src/services/request-capacity';
import { drainNodeBackgroundWork } from '../../../packages/proxy/src/runtime/schedule-background-work';
import { drainNodeResourceWork } from '../../../packages/proxy/src/runtime/schedule-resource-completion';
import type { createCompleteTextResponseHolderWorkerV394 } from '../../../packages/proxy/src/runtime/complete-text-response-holder-worker-v394';
import { attestCompleteTextRoutingV396 } from './attest-complete-text-routing-v396';

type Sql = PostgresDatabaseClient['raw'];
type Urls = Readonly<{ runtime: string; auth: string; cap: string; complete: string; projector: string; sticky: string; admission: string; verifier: string }>;
type HolderWorker = ReturnType<typeof createCompleteTextResponseHolderWorkerV394>;
type Params = Readonly<{
 auditor: Sql; urls: Urls; holderEnv: Parameters<HolderWorker['fetch']>[1];
 createHolderWorker(path: string): HolderWorker;
 wireRequests: readonly { method?: string; url?: string; authorization?: string; body: Uint8Array }[];
 jsonBody: string; sseBody: string; expectedProviderBearer: string;
 drainHolderTasks(tasks: Promise<unknown>[]): Promise<void>;
 stage(name: string, detail?: Record<string, unknown>): void;
}>;
const g = 'cinatoken_gateway';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Real SQL implementations are retained for permitted preparation reads/audit.
 * Any accidental legacy auth, credential planning, owner or usage call fails. */
function exclusiveRepositories(real: GatewayRepositories, forbidden: string[]): GatewayRepositories {
 const allow: Record<string, readonly string[]> = {
  requestPresets: ['getAccessibleBySlug'], guardrails: ['getEffectiveForRequest'],
  apiKeys: ['getApiKeyByIdInWorkspace'], userAuditLogs: ['insertUserAuditLog'],
 };
 const repositories = Object.fromEntries(Object.entries(real).map(([name, value]) => {
  if (name === 'client' || !value || typeof value !== 'object') return [name, value];
  const target = value as Record<string, unknown>;
  return [name, new Proxy(target, { get(object, member) {
   const method = Reflect.get(object, member);
   if (typeof method !== 'function') return method;
   if (allow[name]?.includes(String(member))) return method.bind(object);
   return () => { const call = `${name}.${String(member)}`; forbidden.push(call); throw new Error(`Forbidden legacy repository call: ${call}`); };
  } })];
 }));
 return repositories as unknown as GatewayRepositories;
}

/** Runs only in the successor owned native fixture, after all frozen v400
 * stages. No production composition, external Provider or database is used. */
export async function exerciseCredentialFreeChatIngressNativeV401(p: Params) {
 const beforePosts = p.wireRequests.length;
 assert.equal(beforePosts, 13, 'the inherited frozen v400 scenarios keep their exact physical POST count');
 const realStorage = await createPostgresStorageContext(p.urls.runtime, {
  max: 1, prepare: false, fetch_types: false, connect_timeout: 3,
  idle_timeout: 0, max_lifetime: 0, backoff: false, onnotice() {},
  connection: { application_name: 'credential-free-chat-v401-runtime-storage' },
 });
 if (realStorage.client.driver !== 'postgres') throw new Error('Owned native storage must be PostgreSQL');
 const runtimeClient = realStorage.client;
 const forbidden: string[] = [];
 const storage: StorageContext = { client: realStorage.client, repositories: exclusiveRepositories(realStorage.repositories, forbidden) };
 const capacity = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 32 * 1024 * 1024 });
 const holderTasks: Promise<unknown>[] = [], envelopes: Record<string, unknown>[] = [];
 let holderPath = '/json';
 const composition: CredentialFreeChatIngressCompositionV401 = {
  runtimeConnectionString: p.urls.runtime, authConnectionString: p.urls.auth,
  capabilityConnectionString: p.urls.cap, quoteConnectionString: p.urls.complete,
  projectorConnectionString: p.urls.projector, stickyConnectionString: p.urls.sticky,
  admissionConnectionString: p.urls.admission,
  // Only this trusted maintenance decorator is substituted. It publishes an
  // actual verifier receipt, then executes the actual projector LOGIN client.
  ports: { project: async input => {
   await attestCompleteTextRoutingV396({ verifierConnectionString: p.urls.verifier, modelIds: input.quote.modelIds });
   return readPostgresCompleteTextRoutingProjectionV396(input);
  } },
  holderBinding: { async fetch(request) {
   envelopes.push(await request.clone().json() as Record<string, unknown>);
   return p.createHolderWorker(holderPath).fetch(request, p.holderEnv, {
    waitUntil(task: Promise<unknown>) { holderTasks.push(task); },
   });
  } },
 };
 const app = createProxyApp(async () => storage, {
  credentialFreeChatV401: composition,
  // Logical local reservations, with no production memory/SLO claim.
  httpCapacity: { pool: capacity, reservedBytesPerRequest: 32 * 1024 * 1024 },
 });
 const env: GatewayBindings = { DATABASE_DRIVER: 'postgres', HYPERDRIVE: { connectionString: p.urls.runtime },
  CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED: 'reviewed-v1', REQUEST_BODY_LOGGING: 'off' };
 const drain = async () => {
  await p.drainHolderTasks(holderTasks);
  await drainNodeBackgroundWork(); await drainNodeResourceWork();
  assert.equal(capacity.snapshot().requests, 0); assert.equal(capacity.snapshot().reservedBytes, 0);
  assert.deepEqual(forbidden, []);
 };
 const identity = async (kind: string, output = false) => {
  const suffix = randomUUID(), prefix = `v401-${kind}-${suffix}`;
  const userId = `${prefix}-user`, workspaceId = `${prefix}-workspace`, keyId = `${prefix}-key`;
  const bearer = `sk-v401-local-${suffix}`, hash = `sha256:${sha(bearer)}`;
  const policyId = `${prefix}-policy`, assignmentId = `${prefix}-assignment`, presetId = `${prefix}-preset`, slug = `v401-${suffix}`;
  await p.auditor.unsafe(`INSERT INTO ${g}.users(id,email,budget_max,budget_base,budget_spent,budget_period)
   VALUES($1,$2,100,100,0,'none')`, [userId, `${prefix}@example.invalid`]);
  await p.auditor.unsafe(`INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
   VALUES($1,'personal',$2,'Owned v401 HTTP',$3,'active')`, [workspaceId, userId, prefix]);
  await p.auditor.unsafe(`INSERT INTO ${g}.api_keys(id,key,key_hash,user_id,workspace_id,status,limit_micros,limit_reset)
   VALUES($1,$2,$3,$4,$5,'active',100000000,'daily')`, [keyId, `hashref:${hash}`, hash, userId, workspaceId]);
  await p.auditor.unsafe(`INSERT INTO ${g}.workspace_budgets(id,workspace_id,reset_interval,limit_micros)
   VALUES($1,$2,'daily',100000000)`, [`${prefix}-budget`, workspaceId]);
  await p.auditor.unsafe(`INSERT INTO ${g}.guardrails(id,workspace_id,owner_user_id,name,status)
   VALUES($1,$2,$3,'Owned HTTP policy','active')`, [policyId, workspaceId, userId]);
  const policy = output ? { budget: { limit: 100, period: 'daily' }, output_filters: [{ id: 'output', pattern: 'secret', action: 'block' }] }
   : { budget: { limit: 100, period: 'daily' }, input_filters: [{ id: 'greeting', pattern: 'hello', action: 'redact' }] };
  await p.auditor.unsafe(`INSERT INTO ${g}.guardrail_versions(id,guardrail_id,version,config_json,created_by_user_id)
   VALUES($1,$2,1,$3,$4)`, [`${prefix}-policy-version`, policyId, JSON.stringify(policy), userId]);
  await p.auditor.unsafe(`INSERT INTO ${g}.guardrail_assignments(id,workspace_id,guardrail_id,scope_type,scope_id)
   VALUES($1,$2,$3,'user',$4)`, [assignmentId, workspaceId, policyId, userId]);
  await p.auditor.unsafe(`INSERT INTO ${g}.request_presets(id,workspace_id,owner_user_id,slug,name,visibility,status)
   VALUES($1,$2,$3,$4,'Owned HTTP preset','private','active')`, [presetId, workspaceId, userId, slug]);
  await p.auditor.unsafe(`INSERT INTO ${g}.request_preset_versions(id,preset_id,version,system_prompt,config_json,created_by_user_id)
   VALUES($1,$2,1,'Use concise answers.',$3,$4)`, [`${prefix}-preset-version`, presetId,
    JSON.stringify({ model: 'v361-model', max_completion_tokens: 250, temperature: 0.2 }), userId]);
  return { userId, workspaceId, keyId, bearer, slug };
 };
 type Identity = Awaited<ReturnType<typeof identity>>;
 const body = (who: Identity, stream = false) => ({ model: `@preset/${who.slug}`, messages: [{ role: 'user', content: 'hello' }], stream });
 const request = (who: Identity, alias: string, input = body(who), headers: Record<string, string> = {}) => app.request(alias, {
  method: 'POST', signal: new AbortController().signal,
  headers: { Authorization: `Bearer ${who.bearer}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
 }, env);
 const snapshot = async (who: Identity) => {
  const [row] = await p.auditor.unsafe(`SELECT jsonb_build_object(
   'user',(SELECT to_jsonb(u) FROM ${g}.users u WHERE id=$1),
   'key',(SELECT to_jsonb(k) FROM ${g}.api_keys k WHERE id=$2),
   'ordinary',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM ${g}.user_budget_reservations r WHERE user_id=$1),
   'guardrails',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ${g}.guardrail_budget_reservations r WHERE workspace_id=$3),
   'windows',(SELECT jsonb_agg(to_jsonb(w) ORDER BY scope_type,scope_id,period,period_start) FROM ${g}.guardrail_budget_windows w WHERE workspace_id=$3),
   'audits',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ${g}.user_audit_logs a WHERE user_id=$1),
   'quotes',(SELECT jsonb_agg(to_jsonb(q) ORDER BY quote_id) FROM ${g}.complete_text_quotes_v360 q WHERE api_key_id=$2),
   'admissions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.request_id) FROM ${g}.complete_text_admissions_v361 a
    JOIN ${g}.complete_text_quotes_v360 q USING(quote_id) WHERE q.api_key_id=$2),
   'starts',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.send_start_id) FROM ${g}.complete_text_send_starts_v365 s
    JOIN ${g}.complete_text_quotes_v360 q USING(request_id) WHERE q.api_key_id=$2),
   'observations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.observation_id) FROM cinatoken_response_observation.observations_v392 o
    JOIN ${g}.complete_text_quotes_v360 q USING(request_id) WHERE q.api_key_id=$2),
   'grants',(SELECT jsonb_agg(to_jsonb(gr) ORDER BY gr.grant_id) FROM ${g}.complete_text_attempt_grants_v362 gr
    JOIN ${g}.complete_text_quotes_v360 q USING(quote_id) WHERE q.api_key_id=$2)
   ) AS value`, [who.userId, who.keyId, who.workspaceId]);
  return row!.value;
 };
 try {
  const positive = await identity('positive');
  for (const [alias, stream] of [['/v1/chat/completions', false], ['/api/v1/chat/completions', true]] as const) {
   const count = p.wireRequests.length, wireBody = body(positive, stream), raw = JSON.stringify(wireBody);
   holderPath = stream ? '/sse' : '/json';
   const response = await request(positive, alias, wireBody);
   assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
   assert.equal(response.headers.get('X-Private-Provider-Header'), null); assert.equal(response.headers.get('Cache-Control'), 'no-store');
   assert.equal(response.headers.get('Content-Type'), stream ? 'text/event-stream' : 'application/json');
   const delivered = await response.text(); assert.equal(delivered, stream ? p.sseBody : p.jsonBody); await drain();
   assert.equal(p.wireRequests.length, count + 1);
   const envelope = envelopes.at(-1)!;
   assert.deepEqual(Object.keys(envelope).sort(), ['attemptNonce', 'candidateIndex', 'finalBodyUtf8', 'quoteId', 'requestId', 'routeTargetId']);
   assert.equal(response.headers.get('X-Generation-Id'), envelope.requestId); assert.equal(envelope.routeTargetId, 'v361-route');
   const final = JSON.parse(String(envelope.finalBodyUtf8));
   assert.deepEqual(final.models, ['v361-model']); assert.equal(final.model, 'v361-model');
   assert.equal(final.max_completion_tokens, 250); assert.equal(final.temperature, 0.2);
   assert.equal(final.messages[0].content, 'Use concise answers.'); assert.notEqual(final.messages[1].content, 'hello');
   assert.equal(final.preset, undefined); assert.notEqual(sha(raw), sha(String(envelope.finalBodyUtf8)));
   const [quote] = await p.auditor.unsafe(`SELECT q.*,c.body_sha256 AS capability_body_sha256 FROM ${g}.complete_text_quotes_v360 q
    JOIN ${g}.authenticated_request_capabilities_v356 c USING(request_id) WHERE q.request_id=$1`, [envelope.requestId as string]);
   assert.ok(quote); assert.equal(quote.api_key_id, positive.keyId); assert.equal(quote.user_id, positive.userId);
   assert.equal(quote.original_body_sha256, sha(raw)); assert.equal(quote.capability_body_sha256, sha(raw));
   assert.equal(quote.final_body_sha256, sha(String(envelope.finalBodyUtf8)));
   const [proof] = await p.auditor.unsafe(`SELECT
    (SELECT count(*)::integer FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1) AS grants,
    (SELECT count(*)::integer FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1) AS starts,
    (SELECT count(*)::integer FROM ${g}.complete_text_result_facts_v366 WHERE request_id=$1 AND kind='provider_usage') AS usage,
    (SELECT count(*)::integer FROM ${g}.complete_text_result_facts_v366 WHERE request_id=$1 AND kind IN('provider_bill','provider_zero_charge_observation')) AS bills,
    (SELECT state FROM ${g}.user_budget_reservations WHERE request_id=$1) AS ordinary_state,
    (SELECT count(*)::integer FROM ${g}.guardrail_budget_reservations WHERE request_id=$1 AND state='dispatched') AS guardrails,
    (SELECT count(*)::integer FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1 AND obligation_state='unknown') AS unknown_grants,
    (SELECT count(*)::integer FROM ${g}.complete_text_platform_terminals_v388 WHERE request_id=$1) AS terminals,
    (SELECT count(*)::integer FROM ${g}.api_key_request_logs WHERE id=$1) AS buyer_logs,
    (SELECT count(*)::integer FROM ${g}.user_audit_logs WHERE correlation_id=$1 AND event_type='guardrail_redacted') AS redaction_audits`, [envelope.requestId as string]);
   assert.deepEqual(proof, { grants: 1, starts: 1, usage: 1, bills: 0, ordinary_state: 'dispatched', guardrails: 3,
    unknown_grants: 1, terminals: 0, buyer_logs: 0, redaction_audits: 1 });
   const [observation] = await p.auditor.unsafe('SELECT * FROM cinatoken_response_observation.observations_v392 WHERE request_id=$1', [envelope.requestId as string]);
   assert.ok(observation); assert.equal(observation.observation.rawResponseSha256, sha(delivered));
   assert.equal(Number(observation.observation.rawResponseBytes), Buffer.byteLength(delivered));
   assert.equal(p.wireRequests.at(-1)!.authorization, `Bearer ${p.expectedProviderBearer}`);
   const outbound = JSON.parse(Buffer.from(p.wireRequests.at(-1)!.body).toString('utf8'));
   assert.equal(outbound.model, 'upstream-v361'); assert.equal(outbound.messages[0].content, 'Use concise answers.');
   assert.notEqual(outbound.messages[1].content, 'hello');
   p.stage(`v401-actual-Hono-${stream ? 'SSE-api-alias' : 'JSON-v1-alias'}-real-preset-redaction-four-holds-one-POST-durable-observation`,
    { requestId: envelope.requestId, grantId: observation.grant_id, addedPosts: 1, forbiddenLegacyCalls: 0 });
  }
  for (const header of ['X-OpenRouter-Metadata', 'X-OpenRouter-Experimental-Metadata']) {
   const who = await identity('metadata'), before = await snapshot(who), count = p.wireRequests.length, handed = envelopes.length;
   const response = await request(who, '/v1/chat/completions', body(who), { [header]: 'true' });
   assert.equal(response.status, 400); await response.text(); await drain();
   assert.equal(p.wireRequests.length, count); assert.equal(envelopes.length, handed); assert.deepEqual(await snapshot(who), before);
  }
  p.stage('v401-real-Hono-both-metadata-controls-rejected-preauth-no-policy-quote-or-POST', { addedPosts: 0 });
  {
   const who = await identity('output', true), before = await snapshot(who), count = p.wireRequests.length, handed = envelopes.length;
   const response = await request(who, '/api/v1/chat/completions'); assert.equal(response.status, 403);
   await response.text(); await drain(); assert.equal(p.wireRequests.length, count); assert.equal(envelopes.length, handed);
   assert.deepEqual(await snapshot(who), before);
   p.stage('v401-real-Hono-actual-output-Guardrail-refused-before-quote-admission-or-POST', { addedPosts: 0 });
  }
  {
   await p.auditor.unsafe(`UPDATE ${g}.users SET budget_period='daily',budget_reset_at=clock_timestamp()-interval '1 day' WHERE id=$1`, [positive.userId]);
   const before = await snapshot(positive), count = p.wireRequests.length, handed = envelopes.length;
   const response = await request(positive, '/api/v1/chat/completions'); assert.equal(response.status, 409);
   await response.text(); await drain(); assert.equal(p.wireRequests.length, count); assert.equal(envelopes.length, handed);
   assert.deepEqual(await snapshot(positive), before);
   await p.auditor.unsafe(`UPDATE ${g}.users SET budget_period='none',budget_reset_at=NULL WHERE id=$1`, [positive.userId]);
   p.stage('v401-real-Hono-due-auth-period-live-sent-obligations-remain-pending-no-epoch-reset-quote-or-POST', { addedPosts: 0 });
  }
  assert.equal(envelopes.length, 2); assert.equal(p.wireRequests.length, beforePosts + 2); assert.deepEqual(forbidden, []);
  p.stage('v401-exclusive-Hono-role-client-chain-two-additional-owned-POSTs-no-legacy-auth-owner-credential-plan-or-usage-writer',
   { inheritedPosts: beforePosts, addedPosts: 2, totalPosts: p.wireRequests.length, forbiddenLegacyCalls: 0 });
 } finally {
  // Sent proofs remain immutable and financially unresolved. Destroying the
  // owned cluster is their cleanup; do not delete them or disable any fence.
  await p.drainHolderTasks(holderTasks);
  await drainNodeBackgroundWork(); await drainNodeResourceWork();
  await runtimeClient.raw.end({ timeout: 1 });
 }
}
