import type { Context, MiddlewareHandler } from 'hono';
import type { PostgresDatabaseClient, StorageContext } from '@octafuse/core';
import { MANAGEMENT_API_KEY_PREFIX } from '@octafuse/core';
import type { Env } from '../app';
import { throttleAuthFailure } from '../middleware/auth';
import { createGenerationId, GENERATION_ID_HEADER } from '../middleware/generation-id';
import { textRequestFailureResponse } from '../middleware/text-request-lifecycle';
import { scheduleResourceCompletion } from '../runtime/schedule-resource-completion';
import { observeResourceCleanup, type ResourceCompletionOutcome } from './resource-completion';
import { RequestBodyTooLargeError } from './bounded-request-body';
import { TEXT_REQUEST_DEADLINE_MS } from './request-deadline';
import { getUserModelCircuitOpen } from './user-model-circuit-breaker';
import { originalChatBodySha256 } from './chat-final-quote-input';
import { GatewayErrorCode, type GatewayErrorCodeValue } from './gateway-error-codes';
import { gatewayErrorJson } from './gateway-error-response';
import {
  authenticatePostgresPersonalKeyV395, PostgresPersonalPeriodPendingV395,
  PostgresPersonalAuthCleanupUnconfirmedV395, type AuthenticatedPersonalKeyV395,
} from './postgres-personal-key-auth-v395';
import { PostgresCompleteChatQuoteCleanupUnconfirmedError } from './postgres-complete-chat-quote-v360';
import { PostgresCompleteChatAdmissionCleanupUnconfirmedError } from './postgres-complete-chat-admission-v361';
import { PostgresRoutingProjectionCleanupUnconfirmedV396 } from './postgres-complete-text-routing-projection-v396';
import { createPostgresCompleteTextStickyRoutingV398, PostgresStickyCleanupUnconfirmedV398 } from './postgres-complete-text-sticky-routing-v398';
import { prepareCredentialFreeRouteAttemptsV398 } from './credential-free-route-attempts-v398';
import {
  createCredentialFreeCompleteChatDispatchV400, type CredentialFreeCompleteChatPortsV400,
} from './complete-chat-credential-free-dispatch-v400';
import {
  prepareCredentialFreeChatV401, validateCredentialFreeChatIngressProfileV401,
} from './credential-free-chat-preparation-v401';

/** Server composition only. Shipped runtimes/configurations do not supply this. */
export type CredentialFreeChatIngressCompositionV401 = Readonly<{
  runtimeConnectionString: string;
  authConnectionString: string;
  capabilityConnectionString: string;
  quoteConnectionString: string;
  projectorConnectionString: string;
  stickyConnectionString: string;
  admissionConnectionString: string;
  holderBinding: Readonly<{ fetch(request: Request): Promise<Response> }>;
  /** Trusted SQL adapter; the actual sticky client and its ACK parser still run. */
  stickyClientFactory?: Parameters<typeof createPostgresCompleteTextStickyRoutingV398>[1];
  /** Trusted composition/testing adapters; never obtained from the HTTP request. */
  ports?: CredentialFreeCompleteChatPortsV400;
}>;

const MAX_BODY_BYTES = 1_048_576;
const ROLES = Object.freeze({
  runtimeConnectionString: 'cinatoken_gateway_runtime',
  authConnectionString: 'cinatoken_gateway_personal_key_auth',
  capabilityConnectionString: 'cinatoken_gateway_request_capability_issuer',
  quoteConnectionString: 'cinatoken_gateway_complete_text_quote_issuer',
  projectorConnectionString: 'cinatoken_gateway_complete_text_routing_projector',
  stickyConnectionString: 'cinatoken_gateway_complete_text_sticky_router',
  admissionConnectionString: 'cinatoken_gateway_budget_admission',
});

function validConnection(connection: string | undefined, role: string): boolean {
  if (typeof connection !== 'string' || connection !== connection.trim()) return false;
  try {
    const url = new URL(connection);
    decodeURIComponent(url.pathname);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && decodeURIComponent(url.username) === role
      && !!url.hostname && !!url.password && !!url.pathname && url.pathname !== '/' && !url.hash
      && [...url.searchParams].length <= 1 && [...url.searchParams].every(([key, value]) =>
        key.toLowerCase() === 'sslmode' && ['disable', 'require'].includes(value));
  } catch { return false; }
}

export function isCredentialFreeChatIngressV401(method: string, path: string): boolean {
  return method === 'POST' && /^\/(?:api\/)?v1\/chat\/completions\/?$/u.test(path);
}

function frozenJson<T>(value: T): T {
  const copy: T = JSON.parse(JSON.stringify(value));
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

async function readBody(c: Context<Env>): Promise<Uint8Array<ArrayBuffer>> {
  const deadline = c.get('textRequestLifecycle')!.deadline;
  const stream = c.req.raw.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0, eof = false;
  try {
    while (true) {
      const result = await deadline.wait(() => reader.read());
      deadline.throwIfStopped();
      if (result.done) { eof = true; break; }
      length += result.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new RequestBodyTooLargeError();
      chunks.push(new Uint8Array(result.value));
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (eof) reader.releaseLock();
    else scheduleResourceCompletion(c, observeResourceCleanup(async () => {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }));
  }
}

function cleanupUnconfirmed(error: unknown): boolean {
  return error instanceof PostgresPersonalAuthCleanupUnconfirmedV395
    || error instanceof PostgresCompleteChatQuoteCleanupUnconfirmedError
    || error instanceof PostgresCompleteChatAdmissionCleanupUnconfirmedError
    || error instanceof PostgresRoutingProjectionCleanupUnconfirmedV396
    || error instanceof PostgresStickyCleanupUnconfirmedV398;
}

/** Own the signal bridge and body until EOF or acknowledged cancellation. */
function ownHolderResponse(c: Context<Env>, response: Response, signal: AbortSignal, detachClient: () => void): Response {
  if (!response.body) { detachClient(); return response; }
  const reader = response.body.getReader();
  let resolve!: (outcome: ResourceCompletionOutcome) => void;
  const completion = new Promise<ResourceCompletionOutcome>(done => { resolve = done; });
  let stopped = false, finished = false, cancelling: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = (outcome: ResourceCompletionOutcome): void => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', onAbort);
    detachClient();
    reader.releaseLock();
    resolve(outcome);
  };
  const cancel = (): Promise<void> => {
    if (finished) return Promise.resolve();
    stopped = true;
    cancelling ??= reader.cancel(new Error('Credential-free response delivery stopped'))
      .then(() => finish('confirmed'), () => finish('unconfirmed'));
    return cancelling;
  };
  function onAbort(): void {
    if (stopped) return;
    void cancel();
    controller.error(new Error('Credential-free response delivery stopped'));
  }
  scheduleResourceCompletion(c, completion);
  const body = new ReadableStream<Uint8Array>({
    start(target) {
      controller = target;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(target) {
      if (stopped) return;
      try {
        const result = await reader.read();
        if (stopped) return;
        if (result.done) { stopped = true; finish('confirmed'); target.close(); }
        else target.enqueue(result.value);
      } catch {
        if (stopped) return;
        void cancel();
        target.error(new Error('Credential-free response delivery failed'));
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  return new Response(body, response);
}

function preparationErrorCode(code: string, status: number): GatewayErrorCodeValue {
  switch (code) {
    case 'invalid_json': return GatewayErrorCode.invalidJson;
    case 'missing_model': return GatewayErrorCode.missingModel;
    case 'payload_too_large': return GatewayErrorCode.payloadTooLarge;
    case 'preset_not_found': return GatewayErrorCode.presetNotFound;
    case 'invalid_preset_reference': return GatewayErrorCode.invalidPresetReference;
    case 'preset_invalid': return GatewayErrorCode.presetInvalid;
    case 'guardrail_blocked': return GatewayErrorCode.guardrailBlocked;
    case 'guardrail_invalid': return status === 409 ? GatewayErrorCode.resourceConflict : GatewayErrorCode.guardrailInvalid;
    default: return status === 403 ? GatewayErrorCode.permissionDenied
      : status === 404 ? GatewayErrorCode.modelNotFound
      : status === 409 ? GatewayErrorCode.resourceConflict
      : status === 413 ? GatewayErrorCode.payloadTooLarge : GatewayErrorCode.invalidRequest;
  }
}

/**
 * Terminal middleware runs before legacy Chat auth/initialization. Every enabled
 * outcome returns here, so neither success nor errors can enter legacy owners.
 */
export function createCredentialFreeChatIngressV401(
  composition?: CredentialFreeChatIngressCompositionV401,
  mixedServerOwners = false,
): MiddlewareHandler<Env> {
  // Capture configuration and function references before any request can await.
  const connections = composition ? Object.freeze({
    runtimeConnectionString: composition.runtimeConnectionString,
    authConnectionString: composition.authConnectionString,
    capabilityConnectionString: composition.capabilityConnectionString,
    quoteConnectionString: composition.quoteConnectionString,
    projectorConnectionString: composition.projectorConnectionString,
    stickyConnectionString: composition.stickyConnectionString,
    admissionConnectionString: composition.admissionConnectionString,
  }) : undefined;
  const holder = composition?.holderBinding;
  const fetchHolder = typeof holder?.fetch === 'function' ? holder.fetch.bind(holder) : undefined;
  const ports = Object.freeze({ authenticate: composition?.ports?.authenticate ?? authenticatePostgresPersonalKeyV395,
    issueQuote: composition?.ports?.issueQuote, project: composition?.ports?.project,
    prepare: composition?.ports?.prepare, admit: composition?.ports?.admit,
    newAttemptNonce: composition?.ports?.newAttemptNonce });
  const prepareRoutes = ports.prepare ?? prepareCredentialFreeRouteAttemptsV398;
  const stickyClientFactory = composition?.stickyClientFactory;
  const validLogins = !!connections && !!fetchHolder
    && Object.entries(ROLES).every(([name, role]) => validConnection(connections[name as keyof typeof ROLES], role));
  // Separate Hyperdrive role bindings may have distinct proxy endpoints. The
  // reviewed authorities still target one database name; SQL proves authority.
  const validConfig = validLogins && connections !== undefined
    && Object.values(connections).every(connection => decodeURIComponent(new URL(connection).pathname)
      === decodeURIComponent(new URL(connections.runtimeConnectionString).pathname));
  return async (c, next) => {
    if (!isCredentialFreeChatIngressV401(c.req.method, c.req.path)
      || c.env.CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED === undefined) return next();
    const generationId = createGenerationId();
    c.set('generationId', generationId);
    const failure = (status: 400 | 401 | 403 | 404 | 409 | 413 | 502, code: GatewayErrorCodeValue, message: string) =>
      gatewayErrorJson(c, { status, code, message, headers: { [GENERATION_ID_HEADER]: generationId } });
    const deadline = c.get('textRequestLifecycle')?.deadline;
    const storage = c.get('requestStorage');
    const clientSignal = c.req.raw.signal;
    const mixedBindings = [c.env.AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED, c.env.POSTGRES_CHAT_BUDGET_OWNER_ENABLED,
      c.env.SHARED_KEY_QUOTE_ATTEMPTS_ENABLED, c.env.BUDGET_ADMISSION_HYPERDRIVE,
      c.env.BUDGET_RECOVERY_HYPERDRIVE, c.env.QUOTE_ATTEMPT_HYPERDRIVE].some(value => value !== undefined);
    if (c.env.CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED !== 'reviewed-v1' || !validConfig
      || mixedServerOwners || mixedBindings || !deadline || storage?.client.driver !== 'postgres') {
      return failure(502, GatewayErrorCode.routeResolutionFailed, 'Credential-free Chat configuration is unavailable');
    }
    const capturedConnections = connections!;
    const runtimeClient: PostgresDatabaseClient = Object.freeze({ driver: storage.client.driver,
      raw: storage.client.raw, drizzle: storage.client.drizzle });
    const capturedRepositories = Object.freeze({ ...storage.repositories, client: runtimeClient });
    const capturedStorage: StorageContext = Object.freeze({ client: runtimeClient, repositories: capturedRepositories });
    const headers = new Headers(c.req.raw.headers);
    const authorization = headers.get('authorization') ?? '';
    // This profile has one credential convention. Reject alternate locations and
    // management keys before a personal-auth transaction can mutate anything.
    const query = new URL(c.req.url).searchParams;
    const alternateCredential = ['x-api-key', 'x-goog-api-key', 'api-key', 'x-cinatoken-management-key']
      .some(name => headers.has(name)) || ['key', 'api_key', 'apiKey'].some(name => query.has(name));
    const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
    const bearer = match?.[1];
    if (alternateCredential || !bearer || bearer.startsWith(MANAGEMENT_API_KEY_PREFIX)
      || new TextEncoder().encode(bearer).length < 16 || new TextEncoder().encode(bearer).length > 512) {
      return (await throttleAuthFailure(c)) ?? failure(401, GatewayErrorCode.authFailed, 'Missing or invalid personal Bearer key');
    }
    headers.delete('authorization');
    let holderResponse: Response | undefined, holderEntered = false;
    try {
      deadline.throwIfStopped();
      const bytes = await readBody(c);
      const profile = validateCredentialFreeChatIngressProfileV401({ originalBodyBytes: bytes, headers });
      if (!profile.ok) return failure(profile.status, preparationErrorCode(profile.code, profile.status), profile.message);
      const originalBodySha256 = await deadline.wait(() => originalChatBodySha256(bytes.buffer));
      deadline.throwIfStopped();
      // Do not race writes. Both actual auth and every later LOGIN client await
      // COMMIT/close; the lifecycle also drains all registered policy mutations.
      const authenticated = await deadline.runOwnedMutation(() => ports.authenticate({
        authConnectionString: capturedConnections.authConnectionString, bearer, signal: deadline.signal }));
      deadline.throwIfStopped();
      if (!authenticated) return (await throttleAuthFailure(c))
        ?? failure(401, GatewayErrorCode.authFailed, 'Missing or invalid personal Bearer key');
      const receipt: AuthenticatedPersonalKeyV395 = frozenJson(authenticated);
      const prepared = await prepareCredentialFreeChatV401({ repositories: capturedStorage.repositories,
        storage: capturedStorage, authenticated: receipt, requestId: generationId, originalBodyBytes: bytes,
        originalBodySha256, headers, signal: deadline.signal, deadline, now: new Date(deadline.deadlineAtMs - TEXT_REQUEST_DEADLINE_MS) });
      deadline.throwIfStopped();
      if (!prepared.ok) return failure(prepared.status, preparationErrorCode(prepared.code, prepared.status), prepared.message);
      const dispatch = createCredentialFreeCompleteChatDispatchV400({ ...capturedConnections,
        runtimeClient, bearer, finalQuoteInput: prepared.finalQuoteInput, guardrailIntents: prepared.guardrailIntents,
        sessionRouting: prepared.sessionRouting, signal: deadline.signal,
        holderBinding: { async fetch(request) {
          // A concurrent request may open a user circuit after preparation.
          if (prepared.finalQuoteInput.modelIds.some(model => getUserModelCircuitOpen(receipt.userId, model))) {
            throw new TypeError('Credential-free request model became unavailable');
          }
          deadline.throwIfStopped(); holderEntered = true;
          const bridge = new AbortController();
          const onPreparationStop = () => bridge.abort(deadline.signal.reason);
          const onClientStop = () => bridge.abort(clientSignal.reason);
          deadline.signal.addEventListener('abort', onPreparationStop, { once: true });
          clientSignal.addEventListener('abort', onClientStop, { once: true });
          if (deadline.signal.aborted) onPreparationStop();
          if (clientSignal.aborted) onClientStop();
          const detachClient = () => clientSignal.removeEventListener('abort', onClientStop);
          try {
            holderResponse = await fetchHolder!(new Request(request, { signal: bridge.signal }));
            // After headers, stream delivery has its own owner. The preparation
            // timer may be disposed while the original downstream signal lives.
            deadline.signal.removeEventListener('abort', onPreparationStop);
            holderResponse = ownHolderResponse(c, holderResponse, bridge.signal, detachClient);
            return holderResponse;
          } catch (error) { detachClient(); throw error; }
          finally { deadline.signal.removeEventListener('abort', onPreparationStop); }
        } },
      }, { ...ports, prepare: async input => {
        // The inherited sticky resolver converts lookup exceptions to a miss.
        // Preserve the actual LOGIN failure here before that catch, including
        // an unacknowledged close, and stop before admission or handoff.
        const failures: unknown[] = [];
        let result: Awaited<ReturnType<typeof prepareRoutes>>;
        try {
          result = await prepareRoutes({ ...input, createStickyPorts: input.createStickyPorts ? context => {
            const sticky = stickyClientFactory
              ? createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: capturedConnections.stickyConnectionString,
                context, signal: input.signal }, stickyClientFactory)
              : input.createStickyPorts!(context);
            const getBinding = sticky.routePoolSticky.getBinding.bind(sticky.routePoolSticky);
            return Object.freeze({ routePoolSticky: Object.freeze({ ...sticky.routePoolSticky,
              async getBinding(pool: string, hash: string) {
                if (failures.length) throw failures[0];
                try { return await getBinding(pool, hash); }
                catch (error) { failures.push(error); throw error; }
              },
            }) });
          } : undefined });
        } finally {
          if (failures.length) throw failures.find(cleanupUnconfirmed) ?? failures[0];
        }
        if (result.candidates.some(candidate => candidate.stickySession?.result === 'storage_error')) {
          throw new TypeError('Credential-free sticky lookup was not acknowledged');
        }
        return result;
      }, authenticate: async input => {
        deadline.throwIfStopped();
        if (input.bearer !== bearer || input.authConnectionString !== capturedConnections.authConnectionString) {
          throw new TypeError('Credential-free preparation receipt binding invalid');
        }
        // This request-local closure owns the single acknowledged actual receipt.
        // The actual v360 capability/quote still rejects disabled keys/old epochs.
        return receipt;
      } });
      const response = await deadline.runOwnedMutation(() => dispatch.run());
      deadline.throwIfStopped();
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set(GENERATION_ID_HEADER, generationId);
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch (error) {
      if (cleanupUnconfirmed(error) || (holderEntered && !holderResponse)) {
        scheduleResourceCompletion(c, Promise.resolve('unconfirmed'));
      }
      if (holderResponse?.body) scheduleResourceCompletion(c, observeResourceCleanup(() => holderResponse!.body!.cancel()));
      const stopped = textRequestFailureResponse(error, c)
        ?? (deadline.signal.aborted ? textRequestFailureResponse(deadline.signal.reason, c) : null);
      if (stopped) { stopped.headers.set(GENERATION_ID_HEADER, generationId); return stopped; }
      if (error instanceof PostgresPersonalPeriodPendingV395) {
        return failure(409, GatewayErrorCode.resourceConflict, 'Personal budget period is waiting for unresolved obligations');
      }
      return failure(502, GatewayErrorCode.routeResolutionFailed, 'Credential-free Chat dispatch is unavailable');
    }
  };
}
