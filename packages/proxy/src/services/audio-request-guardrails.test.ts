import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EffectiveGuardrailRow, GatewayRepositories } from '@octafuse/core';
import { dashScopeMultimodalUsageUnavailable } from '../routes/v1/dashscope-multimodal';
import {
	audioOutputGuardrailsRequirePreflightBlock,
	audioTranscriptionGuardrailBody,
	dashScopeMultimodalGuardrailBody,
	redactDashScopeMultimodalBodyForLog,
	runAudioSpeechRequestGuardrails,
	runAudioTranscriptionRequestGuardrails,
	runDashScopeMultimodalRequestGuardrails,
} from './audio-request-guardrails';
import {
	markMultimediaBudgetsBeforeDispatch,
	selectConservativeMultimediaBudgetEstimate,
} from './multimedia-ordinary-budget';

function effective(config: Record<string, unknown>): EffectiveGuardrailRow {
	return {
		id: 'guardrail-1', owner_user_id: 'user-1', name: 'Audio policy', description: null,
		status: 'active', designated_version: 1, latest_version: 1,
		created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z',
		version_id: 'version-1', version_config_json: JSON.stringify(config),
		version_created_by_user_id: 'user-1', version_created_at: '2026-08-29T00:00:00.000Z',
		assignment_id: 'assignment-1', assignment_scope_type: 'user', assignment_scope_id: 'user-1',
	};
}

function repositories(rows: EffectiveGuardrailRow[]): GatewayRepositories {
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
		userAuditLogs: { insertUserAuditLog: async () => undefined },
	} as unknown as GatewayRepositories;
}

describe('audio request Guardrail adapters', () => {
	it('projects only multipart model/prompt text and returns the redacted prompt', async () => {
		assert.deepEqual(audioTranscriptionGuardrailBody('whisper-1', undefined), { model: 'whisper-1' });
		const result = await runAudioTranscriptionRequestGuardrails(repositories([effective({
			input_filters: [{ id: 'secret', pattern: 'secret', action: 'redact' }],
			budget: { limit: 1, period: 'daily' },
		})]), {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1', modelId: 'whisper-1',
			prompt: 'secret vocabulary', correlationId: 'request-1',
			now: new Date('2026-08-29T23:59:59.999Z'),
		});

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(Object.keys(result.body).sort(), ['model', 'prompt']);
		assert.equal(result.body.prompt, '[REDACTED:secret] vocabulary');
		assert.equal(result.budgetIntents[0]?.periodStart, '2026-08-29T00:00:00.000Z');
	});

	it('filters speech input/instructions while preserving the normalized JSON boundary', async () => {
		const result = await runAudioSpeechRequestGuardrails(repositories([effective({
			input_filters: [{ id: 'secret', pattern: 'secret', action: 'redact' }],
		})]), {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1', modelId: 'tts-1', correlationId: 'request-2',
			now: new Date('2026-08-29T00:00:00.000Z'),
			body: {
				model: 'tts-1',
				input: 'secret words',
				instructions: {
					top_level: 'say secret',
					provider_options: { openai: { instructions: 'warm secret voice' } },
					reference_text: 'secret reference transcript',
				},
			},
		});

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.body.input, '[REDACTED:secret] words');
		assert.deepEqual(result.body.instructions, {
			top_level: 'say [REDACTED:secret]',
			provider_options: {
				openai: { instructions: 'warm [REDACTED:secret] voice' },
			},
			reference_text: '[REDACTED:secret] reference transcript',
		});
	});

	it('marks every configured audio output filter for fail-closed preflight rejection', async () => {
		const result = await runAudioSpeechRequestGuardrails(repositories([effective({
			output_filters: [{ id: 'secret', pattern: 'secret', action: 'block' }],
		})]), {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1', modelId: 'tts-1', correlationId: 'request-3',
			now: new Date('2026-08-29T00:00:00.000Z'),
			body: { model: 'tts-1', input: 'hello', voice: 'alloy' },
		});

		assert.equal(result.ok, true);
		if (result.ok) assert.equal(audioOutputGuardrailsRequirePreflightBlock(result), true);
	});

	it('scans and redacts DashScope text without scanning or rewriting audio payloads', async () => {
		const dataUrl = `data:audio/wav;base64,${'A'.repeat(300_000)}`;
		const audioUrl = 'https://media.example/secret-recording.wav?signature=secret';
		const body = {
			model: 'qwen-audio',
			input: {
				messages: [{
					role: 'user',
					content: [
						{ type: 'input_text', text: 'transcribe secret phrase' },
						{ type: 'input_audio', input_audio: { data: dataUrl } },
						{ audio: audioUrl },
					],
				}],
			},
		};
		const projection = dashScopeMultimodalGuardrailBody('qwen-audio', body);
		assert.equal(JSON.stringify(projection).includes(dataUrl), false);
		assert.equal(JSON.stringify(projection).includes(audioUrl), false);

		const result = await runDashScopeMultimodalRequestGuardrails(repositories([effective({
			allowed_providers: ['dashscope'],
			input_filters: [{ id: 'secret', pattern: 'secret', action: 'redact' }],
			budget: { limit: 2, period: 'daily' },
		})]), {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1', modelId: 'qwen-audio',
			body, correlationId: 'request-4', now: new Date('2026-08-29T12:00:00.000Z'),
		});

		assert.equal(result.ok, true);
		if (!result.ok) return;
		const input = result.body.input as typeof body.input;
		assert.equal(input.messages[0]!.content[0]!.text, 'transcribe [REDACTED:secret] phrase');
		assert.equal(input.messages[0]!.content[1]!.input_audio!.data, dataUrl);
		assert.equal(input.messages[0]!.content[2]!.audio, audioUrl);
		assert.deepEqual(result.body.provider, { only: ['dashscope'] });
		assert.equal(result.budgetIntents[0]?.periodStart, '2026-08-29T00:00:00.000Z');
	});

	it('bounds provider validation projection and redacts every media spelling from logs', () => {
		const hugeSelector = 'p'.repeat(500_000);
		const projection = dashScopeMultimodalGuardrailBody('qwen-audio', {
			model: 'qwen-audio',
			provider: { only: [hugeSelector] },
			input: { messages: [] },
		});
		assert.ok(JSON.stringify(projection).length < 1_000);
		assert.equal((projection.provider as { only: string[] }).only[0]!.length, 121);

		const redacted = redactDashScopeMultimodalBodyForLog({
			model: 'qwen-audio',
			input: {
				messages: [{ role: 'user', content: [
					{ text: 'retain semantic text' },
					{ image_url: 'https://media.example/image.png?secret=1' },
					{ video: 'raw-video-base64' },
					{ source: { url: 'https://media.example/audio.wav', data: 'raw-audio-base64' } },
				] }],
			},
		});
		const serialized = JSON.stringify(redacted);
		assert.match(serialized, /retain semantic text/);
		assert.doesNotMatch(serialized, /image\.png|raw-video-base64|audio\.wav|raw-audio-base64/);
	});

	it('preserves the ceiling only for a final unknown or a consumed 2xx without usage', () => {
		assert.equal(dashScopeMultimodalUsageUnavailable({
			upstreamResponseOk: true, usagePromiseUnavailable: false,
			responseBodyTooLarge: true, upstreamOutcomeUnknown: false,
			durationSeconds: 0,
		}), true);
		assert.equal(dashScopeMultimodalUsageUnavailable({
			upstreamResponseOk: false, usagePromiseUnavailable: true,
			responseBodyTooLarge: true, upstreamOutcomeUnknown: false,
			durationSeconds: 0,
		}), false);
		assert.equal(dashScopeMultimodalUsageUnavailable({
			upstreamResponseOk: false, usagePromiseUnavailable: false,
			responseBodyTooLarge: false, upstreamOutcomeUnknown: true,
			durationSeconds: 0,
		}), true);
		assert.equal(dashScopeMultimodalUsageUnavailable({
			upstreamResponseOk: true, usagePromiseUnavailable: false,
			responseBodyTooLarge: false, upstreamOutcomeUnknown: false,
			durationSeconds: 2, durationSource: 'upstream',
		}), false);
		assert.equal(dashScopeMultimodalUsageUnavailable({
			upstreamResponseOk: true, usagePromiseUnavailable: false,
			responseBodyTooLarge: false, upstreamOutcomeUnknown: false,
			durationSeconds: 2, durationSource: 'estimated',
		}), true);
		assert.equal(dashScopeMultimodalUsageUnavailable({
			upstreamResponseOk: true, usagePromiseUnavailable: false,
			responseBodyTooLarge: false, upstreamOutcomeUnknown: false,
			durationSeconds: 0, durationSource: 'upstream',
		}), false);
		assert.equal(dashScopeMultimodalUsageUnavailable({
			upstreamResponseOk: true, usagePromiseUnavailable: false,
			responseBodyTooLarge: false, upstreamOutcomeUnknown: false,
			durationSeconds: 0,
		}), true);
	});

	it('fails closed instead of restoring semantic text beyond the scan depth', async () => {
		let nested: unknown = 'deep secret';
		for (let depth = 0; depth < 30; depth += 1) {
			nested = { content: nested };
		}
		const result = await runDashScopeMultimodalRequestGuardrails(repositories([effective({
			input_filters: [{ id: 'secret', pattern: 'secret', action: 'redact' }],
		})]), {
			userId: 'user-1', apiKeyId: 'key-1', modelId: 'qwen-audio',
			body: { model: 'qwen-audio', input: nested },
			correlationId: 'request-deep', now: new Date('2026-08-29T12:00:00.000Z'),
		});

		assert.deepEqual(result, {
			ok: false,
			status: 403,
			code: 'guardrail_blocked',
			message: 'DashScope multimodal content exceeds the guardrail nesting limit',
			trace: [],
		});
	});
});

describe('multimedia ordinary budget ceiling selection', () => {
	it('selects the highest route ceiling only when every route has provable pricing', () => {
		const result = selectConservativeMultimediaBudgetEstimate([
			{ chargedCost: 0.25, pricingAuditJson: '{"kind":"audio_per_second"}', route: 'a' },
			{ chargedCost: 0.5, pricingAuditJson: '{"kind":"audio_per_second"}', route: 'b' },
		]);
		assert.equal(result?.estimate.route, 'b');
		assert.equal(result?.estimatedChargedCost, 0.5);
	});

	it('distinguishes an explicitly free route from missing or malformed pricing', () => {
		assert.equal(selectConservativeMultimediaBudgetEstimate([
			{ chargedCost: 0, pricingAuditJson: '{"kind":"image_per_image"}' },
		])?.estimatedChargedCost, 0);
		for (const pricingAuditJson of ['{"error":"missing_audio_pricing"}', 'not-json']) {
			assert.equal(selectConservativeMultimediaBudgetEstimate([
				{ chargedCost: 0, pricingAuditJson },
			])?.estimatedChargedCost, null);
		}
	});

	it('fails closed when any eligible route is non-finite or unpriced', () => {
		const result = selectConservativeMultimediaBudgetEstimate([
			{ chargedCost: 1, pricingAuditJson: '{"kind":"audio_tokens"}' },
			{ chargedCost: Number.POSITIVE_INFINITY, pricingAuditJson: '{"kind":"audio_tokens"}' },
		]);
		assert.equal(result?.estimatedChargedCost, null);
	});

	it('marks Guardrail then ordinary immediately before dispatch', async () => {
		const calls: string[] = [];
		await markMultimediaBudgetsBeforeDispatch({
			markGuardrail: async () => { calls.push('guardrail:dispatch'); },
			markOrdinary: async () => { calls.push('ordinary:dispatch'); },
			terminateOrdinary: async () => { calls.push('ordinary:terminate'); },
			terminateGuardrail: async () => { calls.push('guardrail:terminate'); },
		});
		assert.deepEqual(calls, ['guardrail:dispatch', 'ordinary:dispatch']);
	});

	it('cleans both leases without hiding the original pre-dispatch failure', async () => {
		const calls: string[] = [];
		const original = new Error('ordinary dispatch failed');
		await assert.rejects(markMultimediaBudgetsBeforeDispatch({
			markGuardrail: async () => { calls.push('guardrail:dispatch'); },
			markOrdinary: async () => { throw original; },
			terminateOrdinary: async () => { calls.push('ordinary:terminate'); throw new Error('cleanup'); },
			terminateGuardrail: async () => { calls.push('guardrail:terminate'); },
		}), (error) => error === original);
		assert.deepEqual(calls, [
			'guardrail:dispatch',
			'ordinary:terminate',
			'guardrail:terminate',
		]);
	});
});
