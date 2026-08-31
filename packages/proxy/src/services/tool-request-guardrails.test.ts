import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	EffectiveGuardrailRow,
	GatewayRepositories,
	GuardrailPreflightResult,
} from '@octafuse/core';
import {
	dispatchToolGuardrailBudget,
	filterToolGuardrailOutput,
	forfeitToolGuardrailBudgetSafely,
	runToolRequestGuardrails,
	toolGuardrailBudgetMicros,
} from './tool-request-guardrails';

function effective(
	config: Record<string, unknown>,
	overrides: Partial<EffectiveGuardrailRow> = {},
): EffectiveGuardrailRow {
	return {
		id: 'guardrail-1', owner_user_id: 'user-1', name: 'Tool policy', description: null,
		status: 'active', designated_version: 1, latest_version: 1,
		created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z',
		version_id: 'version-1', version_config_json: JSON.stringify(config),
		version_created_by_user_id: 'user-1', version_created_at: '2026-08-29T00:00:00.000Z',
		assignment_id: 'assignment-1', assignment_scope_type: 'user', assignment_scope_id: 'user-1',
		...overrides,
	};
}

function repositories(rows: EffectiveGuardrailRow[], auditEvents: string[] = []): GatewayRepositories {
	return {
		client: {
			driver: 'd1',
			raw: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
		},
		apiKeys: {
			getApiKeyByIdInWorkspace: async (id: string, workspaceId: string) => ({
				id, key: 'sk-test...1234', user_id: 'user-1', workspace_id: workspaceId,
				name: 'Test key', status: 'active', metadata: null, expires_at: null,
				limit_micros: null, limit_reset: null, include_byok_in_limit: false,
				limit_epoch: 0, last_used_at: null,
				created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z',
			}),
		},
		guardrails: { getEffectiveForRequest: async () => rows },
		userAuditLogs: {
			insertUserAuditLog: async (event: { reasonCode: string }) => {
				auditEvents.push(event.reasonCode);
			},
		},
	} as unknown as GatewayRepositories;
}

function successfulGuardrail(
	outputFilters: Extract<GuardrailPreflightResult, { ok: true }>['outputFilters'],
): Extract<GuardrailPreflightResult, { ok: true }> {
	return {
		ok: true,
		body: {},
		inputFilters: [],
		outputFilters,
		requireZdr: false,
		trace: [{
			assignmentId: 'assignment-1', guardrailId: 'guardrail-1', guardrailName: 'Tool policy',
			version: 1, scopeType: 'user', scopeId: 'user-1',
		}],
		redactionCount: 0,
		budgetIntents: [],
	};
}

describe('tool Guardrail policy adapter', () => {
	it('uses a stable pseudo model, fixed provider, redacted input, and request-start budget window', async () => {
		const result = await runToolRequestGuardrails(repositories([effective({
			allowed_models: ['tool:web-search'],
			allowed_providers: ['bocha'],
			input_filters: [{ id: 'secret', pattern: 'secret', action: 'redact' }],
			budget: { limit: 5, period: 'daily' },
		})]), {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1', toolId: 'tool:web-search',
			toolProvider: 'bocha',
			input: {
				query: 'find secret docs',
				allowed_domains: ['secret.example'],
			},
			correlationId: 'request-1',
			now: new Date('2026-08-29T23:59:59.999Z'),
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.body.model, 'tool:web-search');
		assert.deepEqual(result.body.input, {
			query: 'find [REDACTED:secret] docs',
			allowed_domains: ['[REDACTED:secret].example'],
		});
		assert.deepEqual((result.body.provider as { only: string[] }).only, ['bocha']);
		assert.equal(result.budgetIntents[0]?.periodStart, '2026-08-29T00:00:00.000Z');
	});

	it('fails closed for disallowed providers and unverifiable ZDR requirements', async () => {
		const providerAudit: string[] = [];
		const providerBlocked = await runToolRequestGuardrails(repositories([effective({
			allowed_models: ['tool:web-search'], allowed_providers: ['tavily'],
		})], providerAudit), {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1', toolId: 'tool:web-search',
			toolProvider: 'bocha', input: 'query', correlationId: 'request-provider', now: new Date(),
		});
		assert.equal(providerBlocked.ok, false);
		assert.ok(providerAudit.includes('guardrail_blocked'));

		const zdrAudit: string[] = [];
		const zdrBlocked = await runToolRequestGuardrails(repositories([effective({
			allowed_models: ['tool:web-fetch'], allowed_providers: ['jina'], require_zdr: true,
		})], zdrAudit), {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1', toolId: 'tool:web-fetch',
			toolProvider: 'jina', input: 'https://example.com', correlationId: 'request-zdr', now: new Date(),
		});
		assert.equal(zdrBlocked.ok, false);
		if (!zdrBlocked.ok) assert.match(zdrBlocked.message, /zero data retention/u);
		assert.ok(zdrAudit.includes('guardrail_blocked'));
	});

	it('applies bounded output redaction/blocking and audits the decision', async () => {
		const redactAudit: string[] = [];
		const redacted = await filterToolGuardrailOutput(repositories([], redactAudit), {
			userId: 'user-1', apiKeyId: 'key-1', toolId: 'tool:web-fetch', correlationId: 'request-output',
			guardrail: successfulGuardrail([{ id: 'secret', pattern: 'secret', action: 'redact' }]),
			value: { content: 'secret page' },
		});
		assert.deepEqual(redacted, {
			ok: true, value: { content: '[REDACTED:secret] page' }, redactionCount: 1,
		});
		assert.ok(redactAudit.includes('guardrail_output_redacted'));

		const blocked = await filterToolGuardrailOutput(repositories([]), {
			userId: 'user-1', apiKeyId: 'key-1', toolId: 'tool:web-search', correlationId: 'request-block',
			guardrail: successfulGuardrail([{ id: 'secret', pattern: 'secret', action: 'block' }]),
			value: { results: [{ snippet: 'secret' }] },
		});
		assert.deepEqual(blocked, { ok: false, blockedBy: 'secret' });

		const oversized = await filterToolGuardrailOutput(repositories([]), {
			userId: 'user-1', apiKeyId: 'key-1', toolId: 'tool:web-fetch', correlationId: 'request-large',
			guardrail: successfulGuardrail([{ id: 'secret', pattern: 'secret', action: 'block' }]),
			value: { content: 'x'.repeat((2 * 1024 * 1024) + 1) },
		});
		assert.deepEqual(oversized, { ok: false, blockedBy: 'response_too_large' });
	});

	it('uses a safe micro ceiling and releases when dispatch cannot start', async () => {
		assert.equal(toolGuardrailBudgetMicros(0), 0);
		assert.equal(toolGuardrailBudgetMicros(0.0000011), 2);
		assert.equal(toolGuardrailBudgetMicros(Number.POSITIVE_INFINITY), Number.MAX_SAFE_INTEGER);

		const calls: string[] = [];
		const repos = {
			guardrailBudgets: {
				markDispatched: async () => { calls.push('dispatch'); return false; },
				releaseMany: async () => { calls.push('release'); return 1; },
				forfeitMany: async () => { calls.push('forfeit'); return 1; },
			},
		} as unknown as GatewayRepositories;
		await assert.rejects(dispatchToolGuardrailBudget(repos, {
			requestId: 'request-lease', reserved: true,
		}), /could not enter dispatched state/u);
		await forfeitToolGuardrailBudgetSafely(repos, {
			requestId: 'request-lease', reserved: true, reason: 'unknown',
		});
		assert.deepEqual(calls, ['dispatch', 'release', 'forfeit']);
	});
});
