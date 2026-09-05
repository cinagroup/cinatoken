import {
	applyGuardrailFiltersToJson,
	buildGatewayKeyLimitIntent,
	buildWorkspaceBudgetIntent,
	GATEWAY_KEY_LIMIT_INTENT_PREFIX,
	listWorkspaceBudgets,
	WORKSPACE_BUDGET_INTENT_PREFIX,
	enforceRequestGuardrails,
	type GatewayRepositories,
	type GuardrailFilter,
	type GuardrailPreflightResult,
	type GuardrailBudgetIntent,
	type GuardrailBudgetSettlementBasis,
} from '@octafuse/core';

const GUARDRAIL_BUDGET_ADMISSION_LEASE_MS = 2 * 60 * 1000;
const GUARDRAIL_BUDGET_DISPATCH_LEASE_MS = 15 * 60 * 1000;

export type GuardrailBudgetAdmissionResult =
	| { ok: true; reserved: boolean }
	| { ok: false; blocked: true; reason: 'gateway_key_limit' | 'workspace_budget' | 'guardrail_budget'; message: string }
	| { ok: false; blocked: false; message: string };

export async function reserveRequestGuardrailBudgets(
	repositories: GatewayRepositories,
	params: {
		requestId: string;
		intents: GuardrailBudgetIntent[];
		reservedMicros: number;
		settlementBasis?: GuardrailBudgetSettlementBasis;
		now?: Date;
	},
): Promise<GuardrailBudgetAdmissionResult> {
	if (params.intents.length === 0 || params.reservedMicros === 0) return { ok: true, reserved: false };
	const now = params.now ?? new Date();
	const nowIso = now.toISOString();
	try {
		// Bound recovery work per request, but drain more than one page so a short
		// abandoned-lease burst cannot keep an otherwise affordable window blocked.
		for (let pass = 0; pass < 4; pass += 1) {
			const recovered = await repositories.guardrailBudgets.expireBefore(nowIso, 50);
			if (recovered < 50) break;
		}
	} catch (error) {
		console.warn(JSON.stringify({
			message: 'guardrail budget lease recovery failed',
			error: error instanceof Error ? error.message : String(error),
		}));
	}
	const result = await repositories.guardrailBudgets.reserveMany({
		requestId: params.requestId,
		intents: params.intents,
		reservedMicros: params.reservedMicros,
		nowIso,
		expiresAtIso: new Date(now.getTime() + GUARDRAIL_BUDGET_ADMISSION_LEASE_MS).toISOString(),
		settlementBasis: params.settlementBasis,
	});
	return guardrailBudgetAdmissionResult(result);
}

function guardrailBudgetAdmissionResult(
	result: Awaited<ReturnType<GatewayRepositories['guardrailBudgets']['reserveMany']>>,
): GuardrailBudgetAdmissionResult {
	if (result.status === 'reserved' || result.status === 'idempotent') return { ok: true, reserved: true };
	if (result.status === 'blocked') {
		const keyLimit = result.assignmentId?.startsWith(GATEWAY_KEY_LIMIT_INTENT_PREFIX) ?? false;
		if (keyLimit) return { ok: false, blocked: true, reason: 'gateway_key_limit', message: 'Gateway key spend limit exceeded' };
		const workspaceBudget = result.assignmentId?.startsWith(WORKSPACE_BUDGET_INTENT_PREFIX) ?? false;
		return workspaceBudget
			? { ok: false, blocked: true, reason: 'workspace_budget', message: 'Workspace spend budget exceeded' }
			: { ok: false, blocked: true, reason: 'guardrail_budget', message: 'Request blocked by guardrail budget' };
	}
	if (result.status === 'conflict') return { ok: false, blocked: false, message: result.message };
	return { ok: false, blocked: false, message: 'Unexpected Guardrail budget admission result' };
}

export async function extendDispatchedRequestGuardrailBudgets(
	repositories: GatewayRepositories,
	params: { requestId: string; intents: GuardrailBudgetIntent[]; reservedMicros: number; now?: Date },
): Promise<GuardrailBudgetAdmissionResult> {
	if (params.intents.length === 0 || params.reservedMicros === 0) return { ok: true, reserved: false };
	const now = params.now ?? new Date();
	const result = await repositories.guardrailBudgets.extendDispatched({
		requestId: params.requestId,
		intents: params.intents,
		reservedMicros: params.reservedMicros,
		nowIso: now.toISOString(),
		expiresAtIso: new Date(now.getTime() + GUARDRAIL_BUDGET_DISPATCH_LEASE_MS).toISOString(),
	});
	return guardrailBudgetAdmissionResult(result);
}

export async function markRequestGuardrailBudgetsDispatched(
	repositories: GatewayRepositories,
	requestId: string,
	reserved: boolean,
	now = new Date(),
): Promise<void> {
	if (!reserved) return;
	const ok = await repositories.guardrailBudgets.markDispatched(
		requestId,
		now.toISOString(),
		new Date(now.getTime() + GUARDRAIL_BUDGET_DISPATCH_LEASE_MS).toISOString(),
	);
	if (!ok) throw new Error('Guardrail budget reservation could not enter dispatched state');
}

export async function releaseRequestGuardrailBudgets(
	repositories: GatewayRepositories,
	requestId: string,
	reserved: boolean,
	reason: string,
): Promise<void> {
	if (!reserved) return;
	await repositories.guardrailBudgets.releaseMany(requestId, new Date().toISOString(), reason);
}

export async function forfeitRequestGuardrailBudgets(
	repositories: GatewayRepositories,
	requestId: string,
	reserved: boolean,
	reason: string,
): Promise<void> {
	if (!reserved) return;
	await repositories.guardrailBudgets.forfeitMany(requestId, new Date().toISOString(), reason);
}

export const GUARDRAIL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readResponseTextWithinLimit(
	response: Response,
	maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
	if (!response.body) return { ok: true, text: '' };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				await reader.cancel('guardrail_response_too_large').catch(() => undefined);
				return { ok: false };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, text: new TextDecoder().decode(bytes) };
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function auditGuardrailDecision(
	repositories: GatewayRepositories,
	params: {
		workspaceId: string;
		userId: string;
		apiKeyId: string;
		modelIds: string[];
		correlationId: string;
		result: GuardrailPreflightResult;
	},
): Promise<void> {
	const blocked = !params.result.ok;
	const redactionCount = params.result.ok ? params.result.redactionCount : 0;
	const flagCount = params.result.ok ? params.result.flagCount : 0;
	if (!blocked && redactionCount === 0 && flagCount === 0) return;
	const eventType = blocked
		? 'guardrail_blocked'
		: redactionCount > 0 ? 'guardrail_redacted' : 'guardrail_flagged';
	const reasonCode = params.result.ok
		? redactionCount > 0 ? 'guardrail_input_redacted' : 'guardrail_input_flagged'
		: params.result.code;
	await repositories.userAuditLogs.insertUserAuditLog({
		id: crypto.randomUUID(),
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		eventType,
		actorType: 'system',
		source: 'gateway_guardrails',
		reasonCode,
		reasonText: blocked
			? 'Guardrail blocked request'
			: redactionCount > 0 ? 'Guardrail redacted request input' : 'Guardrail flagged request input',
		correlationId: params.correlationId,
		changePayload: JSON.stringify({
			v: 1,
			workspace_id: params.workspaceId,
			model_fingerprint: await sha256(params.modelIds.join('\n')),
			decision_fingerprint: await sha256(params.result.ok
				? JSON.stringify({
					redaction_count: redactionCount,
					flag_count: flagCount,
					builtins: params.result.builtinDetections,
				})
				: params.result.message),
			assignments: params.result.trace.map((item) => ({
				assignment_id: item.assignmentId,
				guardrail_id: item.guardrailId,
				version: item.version,
				scope_type: item.scopeType,
			})),
			redaction_count: redactionCount,
			flag_count: flagCount,
			builtin_detections: params.result.ok ? params.result.builtinDetections : [],
			blocked_builtin: params.result.ok ? null : params.result.blockedBuiltin ?? null,
		}),
	});
}

export async function runRequestGuardrails(
	repositories: GatewayRepositories,
	params: {
		workspaceId: string;
		userId: string;
		apiKeyId: string;
		modelIds: string[];
		body: Record<string, unknown>;
		correlationId: string;
		/** Same immutable request-start instant later persisted as budget_accounted_at. */
		now?: Date;
		/**
		 * Request bodies are filtered by default. Surfaces whose user-controlled
		 * content arrives later (for example, WebSocket frames) must opt out and
		 * fail closed unless they implement filtering at that later boundary.
		 */
		inputFilterSupport?: 'request_body' | 'unsupported';
	},
): Promise<GuardrailPreflightResult> {
	const preflight = await enforceRequestGuardrails(repositories, params);
	const result: GuardrailPreflightResult =
		preflight.ok &&
		params.inputFilterSupport === 'unsupported' &&
		preflight.hasInputGuardrails
			? {
					ok: false,
					status: 403,
					code: 'guardrail_blocked',
					message: 'This request surface cannot safely enforce configured input guardrails',
					trace: preflight.trace,
				}
			: preflight;
	await auditGuardrailDecision(repositories, { ...params, result });
	if (!result.ok) return result;
	const budgetNow = params.now ?? new Date();
	const [key, workspaceBudgets] = await Promise.all([
		repositories.apiKeys.getApiKeyByIdInWorkspace(params.apiKeyId, params.workspaceId),
		listWorkspaceBudgets(repositories.client, params.workspaceId),
	]);
	if (!key) {
		return {
			ok: false,
			status: 409,
			code: 'guardrail_invalid',
			message: 'Gateway key changed while request policy was evaluated',
			trace: result.trace,
		};
	}
	const keyLimitIntent = buildGatewayKeyLimitIntent(key, budgetNow);
	const workspaceBudgetIntents = workspaceBudgets.map((budget) =>
		buildWorkspaceBudgetIntent(budget, budgetNow)
	);
	return {
		...result,
		budgetIntents: [
			...result.budgetIntents,
			...workspaceBudgetIntents,
			...(keyLimitIntent ? [keyLimitIntent] : []),
		],
	};
}

export async function filterGuardrailResponse(
	response: Response,
	filters: GuardrailFilter[],
): Promise<{ response: Response; blockedBy: string | null; redactionCount: number }> {
	if (!response.ok || filters.length === 0) return { response, blockedBy: null, redactionCount: 0 };
	const contentType = response.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().includes('application/json')) {
		return { response, blockedBy: 'unsupported_response_type', redactionCount: 0 };
	}
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > GUARDRAIL_MAX_RESPONSE_BYTES) {
		return { response, blockedBy: 'response_too_large', redactionCount: 0 };
	}
	let parsed: unknown;
	try {
		const bounded = await readResponseTextWithinLimit(response, GUARDRAIL_MAX_RESPONSE_BYTES);
		if (!bounded.ok) {
			return { response, blockedBy: 'response_too_large', redactionCount: 0 };
		}
		parsed = JSON.parse(bounded.text) as unknown;
	} catch {
		return { response, blockedBy: 'invalid_json_response', redactionCount: 0 };
	}
	const result = applyGuardrailFiltersToJson(parsed, filters);
	if (result.blockedBy) return { response, blockedBy: result.blockedBy, redactionCount: 0 };
	const headers = new Headers(response.headers);
	headers.delete('content-length');
	return {
		response: new Response(JSON.stringify(result.value), { status: response.status, statusText: response.statusText, headers }),
		blockedBy: null,
		redactionCount: result.redactionCount,
	};
}

export async function auditGuardrailOutputDecision(
	repositories: GatewayRepositories,
	params: {
		workspaceId: string;
		userId: string;
		apiKeyId: string;
		modelIds: string[];
		correlationId: string;
		trace: Extract<GuardrailPreflightResult, { ok: true }>['trace'];
		blockedBy: string | null;
		redactionCount: number;
	},
): Promise<void> {
	if (!params.blockedBy && params.redactionCount === 0) return;
	await repositories.userAuditLogs.insertUserAuditLog({
		id: crypto.randomUUID(), userId: params.userId, apiKeyId: params.apiKeyId,
		eventType: params.blockedBy ? 'guardrail_blocked' : 'guardrail_redacted', actorType: 'system',
		source: 'gateway_guardrails', reasonCode: params.blockedBy ? 'guardrail_output_blocked' : 'guardrail_output_redacted',
		reasonText: params.blockedBy ? 'Guardrail blocked response output' : 'Guardrail redacted response output',
		correlationId: params.correlationId,
		changePayload: JSON.stringify({
			v: 1, workspace_id: params.workspaceId, direction: 'output', model_fingerprint: await sha256(params.modelIds.join('\n')),
			filter_fingerprint: params.blockedBy ? await sha256(params.blockedBy) : null,
			assignments: params.trace.map((item) => ({ assignment_id: item.assignmentId, guardrail_id: item.guardrailId, version: item.version, scope_type: item.scopeType })),
			redaction_count: params.redactionCount,
		}),
	});
}
