import {
	resolveRequestPreset, preparationRead,
	type GatewayRepositories, type StorageContext, type PreparationControl, type GuardrailBudgetIntent,
} from '@octafuse/core';
import type { authenticatePostgresPersonalKeyV395 } from './postgres-personal-key-auth-v395';
import { originalChatBodySha256, createFinalChatQuoteSnapshot, type FinalChatQuoteSnapshot } from './chat-final-quote-input';
import { parseOpenAiModelFallbacks } from './model-fallbacks';
import { prepareOpenRouterSessionRouting, resolveOpenRouterStickyRouting, type OpenRouterSessionRouting } from './openrouter-session-routing';
import { runRequestGuardrails } from './request-guardrails';
import { getUserModelCircuitOpen } from './user-model-circuit-breaker';
import { JsonStructureBudget, JsonStructureLimitError } from './json-structure-budget';

export const CREDENTIAL_FREE_CHAT_MAX_BODY_BYTES_V401 = 1_048_576;
export const CREDENTIAL_FREE_CHAT_JSON_LIMITS_V401 = Object.freeze({ maxDepth: 16, maxNodes: 16_384, maxPropertyNameChars: 128 });
export type CredentialFreeChatAuthenticatedV401 = NonNullable<Awaited<ReturnType<typeof authenticatePostgresPersonalKeyV395>>>;
export type CredentialFreeChatPreparationFailureV401 = Readonly<{
	ok: false; status: 400 | 403 | 404 | 409 | 413; code: string; message: string;
}>;
export type CredentialFreeChatPreparationInputV401 = Readonly<{
	repositories: GatewayRepositories; storage: StorageContext;
	authenticated: CredentialFreeChatAuthenticatedV401;
	requestId: string; originalBodyBytes: Uint8Array; originalBodySha256: string;
	headers: Headers; signal: AbortSignal; deadline: PreparationControl; now?: Date;
}>;
export type CredentialFreeChatPreparationResultV401 = CredentialFreeChatPreparationFailureV401 | Readonly<{
	ok: true; finalQuoteInput: FinalChatQuoteSnapshot;
	guardrailIntents: readonly GuardrailBudgetIntent[]; sessionRouting: Readonly<OpenRouterSessionRouting>;
}>;
const FIELDS = new Set(['model', 'models', 'messages', 'max_tokens', 'max_completion_tokens', 'stream',
	'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'stop', 'user']);
const CONTROLS = new Set(['preset', 'session_id']);
const fail = (status: CredentialFreeChatPreparationFailureV401['status'], code: string, message: string): CredentialFreeChatPreparationFailureV401 =>
	Object.freeze({ ok: false, status, code, message });
const unsupported = () => fail(400, 'unsupported_profile', 'Request is outside the credential-free flat Chat profile');
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function text(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++i);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}
function profile(body: unknown, controls: boolean): CredentialFreeChatPreparationFailureV401 | null {
	if (!record(body) || Object.keys(body).some(key => !FIELDS.has(key) && !(controls && CONTROLS.has(key)))) return unsupported();
	if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 1_024
		|| body.messages.some(message => !record(message) || Object.keys(message).some(key => key !== 'role' && key !== 'content')
			|| typeof message.role !== 'string' || !['system', 'developer', 'user', 'assistant'].includes(message.role) || !text(message.content))) return unsupported();
	if ('stream' in body && typeof body.stream !== 'boolean') return unsupported();
	for (const key of ['max_tokens', 'max_completion_tokens']) if (key in body
		&& (typeof body[key] !== 'number' || !Number.isSafeInteger(body[key]) || (body[key] as number) < 0 || (body[key] as number) > 999_999_999)) return unsupported();
	for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed']) if (key in body
		&& (typeof body[key] !== 'number' || !Number.isFinite(body[key]))) return unsupported();
	if ('seed' in body && !Number.isSafeInteger(body.seed)) return unsupported();
	if ('user' in body && !text(body.user)) return unsupported();
	if ('stop' in body && !text(body.stop) && !(Array.isArray(body.stop) && body.stop.length <= 4 && body.stop.every(text))) return unsupported();
	if ('session_id' in body && !text(body.session_id)) return unsupported();
	if ('preset' in body && !text(body.preset)) return unsupported();
	if ('model' in body && (!text(body.model) || !body.model.trim() || body.model.trim().length > 240)) return unsupported();
	if ('models' in body && (!Array.isArray(body.models) || body.models.length < 1 || body.models.length > 8
		|| body.models.some(model => !text(model) || !model.trim() || model.trim().length > 240))) return unsupported();
	if (!('model' in body) && !('models' in body) && !(controls && 'preset' in body)) return fail(400, 'missing_model', 'Missing model or models');
	return null;
}
function readIngress(input: { originalBodyBytes: Uint8Array; headers: Headers }):
	{ ok: true; body: Record<string, unknown> } | CredentialFreeChatPreparationFailureV401 {
	if (!(input.originalBodyBytes instanceof Uint8Array)) throw new TypeError('Credential-free Chat bytes are invalid');
	if (input.originalBodyBytes.byteLength > CREDENTIAL_FREE_CHAT_MAX_BODY_BYTES_V401) return fail(413, 'payload_too_large', 'Credential-free Chat body exceeds its byte limit');
	// This profile does not run the legacy metadata diagnostic route planner.
	if (input.headers.has('x-openrouter-metadata') || input.headers.has('x-openrouter-experimental-metadata')) return unsupported();
	let raw: string, body: unknown;
	try {
		raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(input.originalBodyBytes);
		new JsonStructureBudget(CREDENTIAL_FREE_CHAT_JSON_LIMITS_V401).write(raw);
		body = JSON.parse(raw);
	} catch (error) {
		if (error instanceof JsonStructureLimitError) return fail(413, 'payload_too_large', 'Credential-free Chat JSON structure exceeds its limit');
		return fail(400, 'invalid_json', 'Invalid JSON body');
	}
	const invalid = profile(body, true);
	if (invalid) return invalid;
	const session = prepareOpenRouterSessionRouting(body as Record<string, unknown>, input.headers);
	if (!session.ok) return fail(400, 'invalid_request', session.message);
	return { ok: true, body: body as Record<string, unknown> };
}

/** Read-only, bounded pre-auth check. It never looks up a key, policy or route. */
export function validateCredentialFreeChatIngressProfileV401(input: {
	originalBodyBytes: Uint8Array; headers: Headers;
}): Readonly<{ ok: true }> | CredentialFreeChatPreparationFailureV401 {
	const result = readIngress(input);
	return result.ok ? Object.freeze({ ok: true }) : result;
}

/**
 * Review-only preparation before quote enrollment. The caller owns the actual
 * acknowledged v395 receipt and the deadline's mutation drain. This module
 * never authenticates, reserves, plans credentials, grants or dispatches.
 */
export async function prepareCredentialFreeChatV401(input: CredentialFreeChatPreparationInputV401): Promise<CredentialFreeChatPreparationResultV401> {
	if (!(input.originalBodyBytes instanceof Uint8Array)) throw new TypeError('Credential-free Chat bytes are invalid');
	if (input.originalBodyBytes.byteLength > CREDENTIAL_FREE_CHAT_MAX_BODY_BYTES_V401) return fail(413, 'payload_too_large', 'Credential-free Chat body exceeds its byte limit');
	const bytes = new Uint8Array(input.originalBodyBytes), headers = new Headers(input.headers);
	const requestId = input.requestId, originalHash = input.originalBodySha256, signal = input.signal;
	const nowMs = input.now?.getTime() ?? Date.now();
	const receipt = input.authenticated;
	const identity = Object.freeze({ keyId: receipt?.keyId, userId: receipt?.userId, workspaceId: receipt?.workspaceId,
		budgetEpoch: receipt?.budgetEpoch, keyLimitEpoch: receipt?.keyLimitEpoch });
	const originalRepositories = input.repositories, client = originalRepositories.client;
	if (input.storage.repositories !== originalRepositories || input.storage.client !== client || client.driver !== 'postgres'
		|| !identity.keyId || !identity.userId || !identity.workspaceId
		|| !Number.isSafeInteger(identity.budgetEpoch) || identity.budgetEpoch! < 0
		|| !Number.isSafeInteger(identity.keyLimitEpoch) || identity.keyLimitEpoch! < 0
		|| !requestId || requestId.length > 128 || !/^[0-9a-f]{64}$/u.test(originalHash) || !Number.isSafeInteger(nowMs)) {
		throw new TypeError('Credential-free Chat preparation contract invalid');
	}
	const control = input.deadline;
	const stop = control.throwIfStopped.bind(control), wait = control.wait, own = control.runOwnedMutation;
	const live = () => { signal.throwIfAborted(); stop(); };
	const deadline: PreparationControl = Object.freeze({ signal: control.signal, throwIfStopped: live,
		wait<T>(operation: () => Promise<T>): Promise<T> { return (wait<T>).call(control, () => { live(); return operation(); }); },
		runOwnedMutation<T>(operation: () => Promise<T>): Promise<T> { return (own<T>).call(control, () => { live(); return operation(); }); } });
	// Capture the few permitted repository methods before any asynchronous read.
	const repositories: GatewayRepositories = {
		...originalRepositories,
		client: Object.freeze({ driver: client.driver, raw: client.raw, drizzle: client.drizzle }),
		requestPresets: { ...originalRepositories.requestPresets, getAccessibleBySlug: originalRepositories.requestPresets.getAccessibleBySlug.bind(originalRepositories.requestPresets) },
		guardrails: { ...originalRepositories.guardrails, getEffectiveForRequest: originalRepositories.guardrails.getEffectiveForRequest.bind(originalRepositories.guardrails) },
		apiKeys: { ...originalRepositories.apiKeys, getApiKeyByIdInWorkspace: originalRepositories.apiKeys.getApiKeyByIdInWorkspace.bind(originalRepositories.apiKeys) },
		userAuditLogs: { ...originalRepositories.userAuditLogs, insertUserAuditLog: originalRepositories.userAuditLogs.insertUserAuditLog.bind(originalRepositories.userAuditLogs) },
	};
	live();
	const ingress = readIngress({ originalBodyBytes: bytes, headers });
	if (!ingress.ok) return ingress;
	const computedHash = await preparationRead(deadline, () => originalChatBodySha256(bytes.buffer));
	if (computedHash !== originalHash) throw new TypeError('Credential-free Chat original body hash differs');
	const session = prepareOpenRouterSessionRouting(ingress.body, headers);
	if (!session.ok) return fail(400, 'invalid_request', session.message);
	const preset = await preparationRead(deadline, () => resolveRequestPreset(repositories,
		identity.workspaceId!, identity.userId!, session.body, 'chat'));
	if (!preset.ok) return fail(preset.status, preset.code, preset.message);
	const presetProfile = profile(preset.body, false);
	if (presetProfile) return presetProfile;
	let parsed = parseOpenAiModelFallbacks(preset.body);
	if (!parsed.ok) return fail(400, parsed.missingModel ? 'missing_model' : 'invalid_request', parsed.message);
	// No outer cancellable wait around the audit: runRequestGuardrails awaits
	// registered writes even if the request signal changes while SQL is in flight.
	const guardrail = await runRequestGuardrails(repositories, { workspaceId: identity.workspaceId!, userId: identity.userId!,
		apiKeyId: identity.keyId!, modelIds: [...parsed.value.modelIds], body: preset.body, correlationId: requestId,
		now: new Date(nowMs), control: deadline });
	live();
	if (!guardrail.ok) return fail(guardrail.status, guardrail.code, guardrail.message);
	if (guardrail.outputFilters.length > 0) return fail(403, 'unsupported_profile', 'Output guardrails require a separately proven response owner');
	const finalProfile = profile(guardrail.body, false);
	if (finalProfile) return finalProfile;
	parsed = parseOpenAiModelFallbacks(guardrail.body);
	if (!parsed.ok) return fail(400, parsed.missingModel ? 'missing_model' : 'invalid_request', parsed.message);
	const finalParsed = parsed.value;
	// Default flat model IDs are checked without reading credential routes.
	// Conservatively reject the request if any quoted candidate is user-blocked.
	if (finalParsed.modelIds.some(model => getUserModelCircuitOpen(identity.userId!, model))) {
		return fail(403, 'user_model_circuit_open', 'Request model is temporarily unavailable for this user');
	}
	const routing = Object.freeze(resolveOpenRouterStickyRouting(session.routing, guardrail.body, 'chat'));
	const encoded = JSON.stringify(guardrail.body);
	if (new TextEncoder().encode(encoded).byteLength > CREDENTIAL_FREE_CHAT_MAX_BODY_BYTES_V401) return fail(413, 'payload_too_large', 'Final credential-free Chat body exceeds its byte limit');
	const finalQuoteInput = await preparationRead(deadline, () => createFinalChatQuoteSnapshot({ requestId,
		originalBodySha256: originalHash, finalBody: guardrail.body, parsed: finalParsed }));
	if (new TextEncoder().encode(finalQuoteInput.finalBodyUtf8).byteLength > CREDENTIAL_FREE_CHAT_MAX_BODY_BYTES_V401) return fail(413, 'payload_too_large', 'Final credential-free Chat body exceeds its byte limit');
	live();
	const intents = JSON.parse(JSON.stringify(guardrail.budgetIntents)) as GuardrailBudgetIntent[];
	return Object.freeze({ ok: true, finalQuoteInput, guardrailIntents: Object.freeze(intents.map(intent => Object.freeze(intent))), sessionRouting: routing });
}
