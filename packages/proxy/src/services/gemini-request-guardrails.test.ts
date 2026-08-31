import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	EffectiveGuardrailRow,
	GatewayRepositories,
} from '@octafuse/core';
import {
	geminiBodyForBudgetEstimate,
	runGeminiRequestGuardrails,
} from './gemini-request-guardrails';

function effective(config: Record<string, unknown>): EffectiveGuardrailRow {
	return {
		id: 'guardrail-1', owner_user_id: 'user-1', name: 'Gemini policy', description: null,
		status: 'active', designated_version: 1, latest_version: 1,
		created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z',
		version_id: 'version-1', version_config_json: JSON.stringify(config),
		version_created_by_user_id: 'user-1', version_created_at: '2026-08-29T00:00:00.000Z',
		assignment_id: 'assignment-1', assignment_scope_type: 'user', assignment_scope_id: 'user-1',
	};
}

function repositories(rows: EffectiveGuardrailRow[], audits: unknown[] = []): GatewayRepositories {
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
		userAuditLogs: { insertUserAuditLog: async (event: unknown) => { audits.push(event); } },
	} as unknown as GatewayRepositories;
}

describe('Gemini request guardrail adapter', () => {
	it('redacts native contents/system fields and pins budget windows to request start', async () => {
		const audits: unknown[] = [];
		const originalExtension = { passthrough: true };
		const result = await runGeminiRequestGuardrails(repositories([effective({
			input_filters: [{ id: 'secret', pattern: 'secret', action: 'redact' }],
			budget: { limit: 2, period: 'daily' },
		})], audits), {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1', modelId: 'google/gemini-pro',
			body: {
				contents: [{ role: 'user', parts: [{ text: 'secret prompt' }] }],
				systemInstruction: { parts: [{ text: 'secret system' }] },
				input: originalExtension,
			},
			action: 'generateContent', correlationId: 'request-1',
			now: new Date('2026-08-29T23:59:59.999Z'),
		});

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(
			((result.body.contents as Array<{ parts: Array<{ text: string }> }>)[0]!.parts[0]!.text),
			'[REDACTED:secret] prompt',
		);
		assert.equal(
			((result.body.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text),
			'[REDACTED:secret] system',
		);
		assert.equal(result.body.input, originalExtension);
		assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'stream'), false);
		assert.equal(result.redactionCount, 2);
		assert.equal(result.budgetIntents[0]?.periodStart, '2026-08-29T00:00:00.000Z');
		assert.equal(result.budgetIntents[0]?.periodEnd, '2026-08-30T00:00:00.000Z');
		assert.equal(audits.length, 1);
	});

	it('treats the streamGenerateContent path action as streaming for output policies', async () => {
		const result = await runGeminiRequestGuardrails(repositories([effective({
			output_filters: [{ id: 'secret', pattern: 'secret', action: 'block' }],
		})]), {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1', modelId: 'google/gemini-pro',
			body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
			action: 'streamGenerateContent', correlationId: 'request-2',
			now: new Date('2026-08-29T00:00:00.000Z'),
		});

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, 'guardrail_blocked');
	});

	it('maps Gemini nested output limits into the conservative budget estimate input', () => {
		const body = {
			contents: [],
			generationConfig: { maxOutputTokens: 32_768, temperature: 0.2 },
		};
		const estimated = geminiBodyForBudgetEstimate(body);
		assert.equal(estimated.max_output_tokens, 32_768);
		assert.equal(estimated.generationConfig, body.generationConfig);
		assert.equal(Object.prototype.hasOwnProperty.call(body, 'max_output_tokens'), false);
	});
});
