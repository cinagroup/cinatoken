import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyGuardrailFiltersToJson,
	enforceRequestGuardrails,
	validateGuardrailConfig,
	validateGuardrailRegex,
} from './guardrails';
import type { EffectiveGuardrailRow } from './db/guardrails-types';
import { guardrailBudgetUnits } from './db/guardrail-budget-types';
import type { GatewayRepositories } from './storage/repositories-types';

function effective(config: Record<string, unknown>, overrides: Partial<EffectiveGuardrailRow> = {}): EffectiveGuardrailRow {
	return {
		id: 'guardrail-1', workspace_id: 'ws-1', owner_user_id: 'user-1', name: 'Production policy', description: null,
		status: 'active', designated_version: 1, latest_version: 1,
		created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z',
		version_id: 'version-1', version_config_json: JSON.stringify(config), version_created_by_user_id: 'user-1',
		version_created_at: '2026-08-29T00:00:00.000Z', assignment_id: 'assignment-1',
		assignment_scope_type: 'user', assignment_scope_id: 'user-1', ...overrides,
	};
}

test('Guardrail budget micros saturate before JavaScript integer precision is lost', () => {
	assert.equal(guardrailBudgetUnits(Number.MAX_VALUE), Number.MAX_SAFE_INTEGER);
	assert.equal(guardrailBudgetUnits(Number.POSITIVE_INFINITY), Number.MAX_SAFE_INTEGER);
	assert.equal(guardrailBudgetUnits(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
	assert.equal(guardrailBudgetUnits(0.000001), 1);
	assert.equal(guardrailBudgetUnits(0.0000001), 0);
	assert.equal(guardrailBudgetUnits(0.0000001, 'ceiling'), 1);
});

function repos(rows: EffectiveGuardrailRow[]): GatewayRepositories {
	return {
		guardrails: {
			getEffectiveForRequest: async () => rows,
		},
	} as unknown as GatewayRepositories;
}

test('guardrail validation rejects unsafe regex constructs and unknown fields', () => {
	assert.equal(validateGuardrailRegex('(a+)+').ok, false);
	assert.equal(validateGuardrailRegex('(?:a|aa)+').ok, false);
	assert.equal(validateGuardrailRegex('((a|aa))+$').ok, false);
	assert.equal(validateGuardrailRegex('((ab)){2,}').ok, false);
	assert.equal(validateGuardrailRegex('(?=secret)').ok, false);
	assert.equal(validateGuardrailRegex('(secret)\\1').ok, false);
	assert.equal(validateGuardrailRegex('a{1,}a{1,}b').ok, false);
	assert.equal(validateGuardrailRegex('a{1,}?a{1,}?b').ok, false);
	assert.equal(validateGuardrailRegex('[a]{1,1000000}[a]{1,1000000}b').ok, false);
	assert.equal(validateGuardrailRegex('a{1,1000000}a{1,1000000}b').ok, false);
	assert.equal(validateGuardrailRegex('a+?a+?b').ok, false);
	assert.equal(validateGuardrailRegex('\\d+\\d+X').ok, false);
	assert.equal(validateGuardrailRegex('(?:a+)(?:a+)b').ok, false);
	assert.equal(validateGuardrailRegex('^(.+)?(.+)?(.+)?(.+)?(.+)?(.+)?a{41}$').ok, false);
	assert.equal(validateGuardrailRegex('a?a?a?b').ok, false);
	assert.equal(validateGuardrailRegex('a\\{1,\\}').ok, true);
	assert.equal(validateGuardrailRegex('[{1,}]').ok, true);
	assert.equal(validateGuardrailRegex('\\d{4}').ok, true);
	assert.equal(validateGuardrailRegex('a{4,4}').ok, true);
	assert.equal(validateGuardrailRegex('api[_-]?key').ok, true);
	assert.equal(validateGuardrailRegex('[a-z]{1,64}@example\\.com').ok, true);
	assert.equal(validateGuardrailRegex('foo|bar{1,64}').ok, true);
	assert.equal(validateGuardrailRegex('\\(literal\\)').ok, true);
	assert.equal(validateGuardrailRegex('\\d{4}-\\d{2}-\\d{2}').ok, true);
	assert.equal(validateGuardrailRegex('a+').ok, false);
	assert.equal(validateGuardrailRegex('.*password').ok, false);
	assert.equal(validateGuardrailRegex('a{1,256}').ok, true);
	assert.equal(validateGuardrailRegex('a{1,257}').ok, false);
	assert.equal(validateGuardrailRegex('a{4096}').ok, true);
	assert.equal(validateGuardrailRegex('a{4097}').ok, false);
	assert.deepEqual(validateGuardrailConfig({ unexpected: true }), {
		ok: false,
		message: 'Unsupported guardrail field(s): unexpected',
	});
});

test('input block runs before redaction and never forwards matching content', async () => {
	const result = await enforceRequestGuardrails(repos([effective({
		input_filters: [
			{ id: 'redact-secret', pattern: 'secret', action: 'redact' },
			{ id: 'block-exfiltration', pattern: 'send.{1,64}password', action: 'block' },
		],
	})]), {
		workspaceId: 'ws-1', userId: 'user-1', apiKeyId: 'key-1', modelIds: ['openai/gpt-5'],
		body: { model: 'openai/gpt-5', messages: [{ role: 'user', content: 'send the password and secret' }] },
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, 'guardrail_blocked');
});

test('composes user and key policies as intersections and unions', async () => {
	const rows = [
		effective({
			allowed_models: ['openai/gpt-5'], allowed_providers: ['OpenAI', 'Azure'],
			input_filters: [{ id: 'email', pattern: '[a-z]{1,64}@example\\.com', action: 'redact' }],
			require_zdr: true,
		}),
		effective({
			allowed_models: ['openai/gpt-5', 'anthropic/claude'], allowed_providers: ['Azure', 'Anthropic'],
			input_filters: [{ id: 'phone', pattern: '\\b555-\\d{4}\\b', action: 'redact' }],
		}, { id: 'guardrail-2', assignment_id: 'assignment-2', assignment_scope_type: 'api_key', assignment_scope_id: 'key-1' }),
	];
	const result = await enforceRequestGuardrails(repos(rows), {
		workspaceId: 'ws-1', userId: 'user-1', apiKeyId: 'key-1', modelIds: ['openai/gpt-5'],
		body: { model: 'openai/gpt-5', provider: { only: ['Azure', 'OpenAI'] }, messages: [{ role: 'user', content: 'a@example.com 555-1234' }] },
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual((result.body.provider as Record<string, unknown>).only, ['Azure']);
	assert.equal((result.body.messages as Array<{ content: string }>)[0]!.content, '[REDACTED:email] [REDACTED:phone]');
	assert.equal(result.redactionCount, 2);
	assert.equal(result.requireZdr, true);
});

test('each active model policy must allow every fallback candidate', async () => {
	const result = await enforceRequestGuardrails(repos([effective({ allowed_models: ['openai/gpt-5'] })]), {
		workspaceId: 'ws-1', userId: 'user-1', apiKeyId: 'key-1', modelIds: ['openai/gpt-5', 'anthropic/claude'],
		body: { model: 'openai/gpt-5', models: ['anthropic/claude'], messages: [] },
	});
	assert.equal(result.ok, false);
});

test('model-group ZDR policy injects the provider control for matching models', async () => {
	const result = await enforceRequestGuardrails(repos([effective({ zdr: { anthropic: true, openai: false } })]), {
		workspaceId: 'ws-1', userId: 'user-1', apiKeyId: 'key-1', modelIds: ['anthropic/claude-sonnet'],
		body: { model: 'anthropic/claude-sonnet', messages: [] },
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.requireZdr, true);
	assert.equal((result.body.provider as Record<string, unknown>).zdr, true);
});

test('budget evaluation returns assignment intents pinned to UTC windows without querying settled spend', async () => {
	const rows = [
		effective({ budget: { limit: 10, period: 'daily' } }),
		effective({ budget: { limit: 2.5, period: 'weekly' } }, {
			id: 'guardrail-2', designated_version: 3, assignment_id: 'assignment-2',
			assignment_scope_type: 'api_key', assignment_scope_id: 'key-1',
		}),
		effective({ budget: { limit: 0.000001, period: 'monthly' } }, {
			id: 'guardrail-3', designated_version: 7, assignment_id: 'assignment-3',
		}),
	];
	const result = await enforceRequestGuardrails(repos(rows), {
		workspaceId: 'ws-1', userId: 'user-1', apiKeyId: 'key-1', modelIds: ['openai/gpt-5'], body: { model: 'openai/gpt-5', messages: [] },
		now: new Date('2026-08-30T23:59:59.999Z'),
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.budgetIntents, [
		{
			workspaceId: 'ws-1', assignmentId: 'assignment-1', guardrailId: 'guardrail-1', guardrailVersion: 1,
			scopeType: 'user', scopeId: 'user-1', period: 'daily',
			periodStart: '2026-08-30T00:00:00.000Z', periodEnd: '2026-08-31T00:00:00.000Z',
			limitMicros: 10_000_000,
		},
		{
			workspaceId: 'ws-1', assignmentId: 'assignment-2', guardrailId: 'guardrail-2', guardrailVersion: 3,
			scopeType: 'api_key', scopeId: 'key-1', period: 'weekly',
			periodStart: '2026-08-24T00:00:00.000Z', periodEnd: '2026-08-31T00:00:00.000Z',
			limitMicros: 2_500_000,
		},
		{
			workspaceId: 'ws-1', assignmentId: 'assignment-3', guardrailId: 'guardrail-3', guardrailVersion: 7,
			scopeType: 'user', scopeId: 'user-1', period: 'monthly',
			periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z',
			limitMicros: 1,
		},
	]);
});

test('streaming fails closed when output filtering is configured', async () => {
	const result = await enforceRequestGuardrails(repos([effective({ output_filters: [{ id: 'secret', pattern: 'secret', action: 'block' }] })]), {
		workspaceId: 'ws-1', userId: 'user-1', apiKeyId: 'key-1', modelIds: ['openai/gpt-5'], body: { model: 'openai/gpt-5', stream: true, messages: [] },
	});
	assert.equal(result.ok, false);
});

test('non-stream output filtering blocks before redacting', () => {
	const result = applyGuardrailFiltersToJson(
		{ choices: [{ message: { content: 'secret token' } }] },
		[
			{ id: 'token-redact', pattern: 'token', action: 'redact' },
			{ id: 'secret-block', pattern: 'secret', action: 'block' },
		],
	);
	assert.equal(result.blockedBy, 'secret-block');
	assert.equal(result.value, null);
});
