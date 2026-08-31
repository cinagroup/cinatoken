import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	EffectiveGuardrailRow,
	GatewayRepositories,
	ModelRow,
} from '@octafuse/core';
import type { RouteResult } from './model-router';
import { runRequestGuardrails } from './request-guardrails';
import { GatewayErrorCode } from './gateway-error-codes';
import {
	dashScopeRealtimeEndpointSettlementMode,
	dashScopeRealtimePricingCeilingFailureContract,
	dashScopeRealtimeProvableBillingOperation,
	dashScopeRealtimeUnprovableOperationMessage,
} from '../routes/v1/dashscope-realtime';
import {
	buildDashScopeRealtimeBudgetPlan,
	dashScopeRealtimeCriticalSettlement,
	dashScopeRealtimeSettlementMode,
	DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
	DASHSCOPE_REALTIME_GUARDRAIL_LEASE_MS,
	DASHSCOPE_REALTIME_MAX_SESSION_MS,
	realtimeGuardrailBudgetModeSupported,
} from './dashscope-realtime-guardrails';

function model(pricingProfile: unknown): ModelRow {
	return {
		id: 'audio/model',
		display_name: 'Audio model',
		vendor: 'dashscope',
		context_window: null,
		max_tokens: null,
		pricing_profile: JSON.stringify(pricingProfile),
		tags: '[]',
		description: null,
		metadata: null,
		input_modalities: '["audio"]',
		output_modalities: '["text"]',
		released_at: null,
		created_at: '2026-01-01T00:00:00.000Z',
	};
}

function route(): RouteResult {
	return {
		targetId: 'route-1',
		modelSurfaceId: 'surface-1',
		routePoolId: 'pool-1',
		providerId: 'dashscope',
		providerName: 'DashScope',
		providerModelName: 'fun-asr-realtime',
		upstreamProtocol: 'dashscope',
		upstreamOperation: 'audio.transcriptions.realtime.inference',
		adapter: 'passthrough',
		providerEndpoints: {},
		providerApiKey: 'secret',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
	};
}

const repos = {
	systemConfig: { getConfig: async () => null },
} as unknown as GatewayRepositories;

describe('DashScope realtime Endpoint billing boundary', () => {
	it('admits only duration operations with an exact Endpoint pricing operation', () => {
		for (const operation of [
			'audio.transcriptions.realtime.inference',
			'audio.transcriptions.realtime.session',
		] as const) {
			assert.equal(dashScopeRealtimeProvableBillingOperation(operation), operation);
			assert.equal(dashScopeRealtimeUnprovableOperationMessage(operation), null);
		}
		assert.equal(
			dashScopeRealtimeProvableBillingOperation('audio.speech.realtime.inference'),
			null,
		);
		assert.match(
			dashScopeRealtimeUnprovableOperationMessage('audio.speech.realtime.inference') ?? '',
			/Unicode code-point ceiling/i,
		);
		assert.equal(
			dashScopeRealtimeProvableBillingOperation('audio.speech.realtime.session'),
			null,
		);
		assert.match(
			dashScopeRealtimeUnprovableOperationMessage('audio.speech.realtime.session') ?? '',
			/independent inference pricing/i,
		);
	});

	it('fails every route closed when any Endpoint ceiling is unprovable', () => {
		assert.deepEqual(dashScopeRealtimePricingCeilingFailureContract(null), {
			status: 502,
			code: GatewayErrorCode.routeResolutionFailed,
			message: 'DashScope realtime pricing cannot prove a finite charged-cost ceiling for every eligible route',
		});
		assert.equal(dashScopeRealtimePricingCeilingFailureContract(0), null);
		assert.equal(dashScopeRealtimePricingCeilingFailureContract(6.01), null);
	});

	it('settles only authoritative upstream or verified PCM duration facts', () => {
		const common = {
			operation: 'audio.transcriptions.realtime.inference' as const,
			errorMessage: null,
			initialHandshakeError: false,
			upstreamOutcomeUnknown: false,
		};
		assert.equal(dashScopeRealtimeEndpointSettlementMode({
			...common, durationSeconds: 1, durationSource: 'upstream',
		}), 'actual');
		assert.equal(dashScopeRealtimeEndpointSettlementMode({
			...common, durationSeconds: 0, durationSource: 'upstream',
		}), 'actual');
		assert.equal(dashScopeRealtimeEndpointSettlementMode({
			...common, durationSeconds: 1, durationSource: 'media',
		}), 'actual');
		for (const unprovable of [
			{ ...common, durationSeconds: undefined, durationSource: undefined },
			{ ...common, durationSeconds: 1, durationSource: undefined },
			{ ...common, durationSeconds: 1, durationSource: 'estimated' as const },
			{ ...common, durationSeconds: Number.NaN, durationSource: 'upstream' as const },
		]) {
			assert.equal(dashScopeRealtimeEndpointSettlementMode(unprovable), 'forfeit');
		}
		assert.equal(dashScopeRealtimeEndpointSettlementMode({
			...common,
			operation: 'audio.speech.realtime.inference',
			durationSeconds: 1,
			durationSource: 'upstream',
		}), 'forfeit');
	});

	it('distinguishes known-zero handshake rejection from transport uncertainty', () => {
		const common = {
			operation: 'audio.transcriptions.realtime.session' as const,
			errorMessage: 'Realtime upstream handshake failed: HTTP 401',
			initialHandshakeError: true,
			durationSeconds: undefined,
		};
		assert.equal(dashScopeRealtimeEndpointSettlementMode({
			...common, upstreamOutcomeUnknown: false,
		}), 'known_zero');
		assert.equal(dashScopeRealtimeEndpointSettlementMode({
			...common, upstreamOutcomeUnknown: true,
		}), 'forfeit');
	});
});

function effectiveGuardrail(config: Record<string, unknown>): EffectiveGuardrailRow {
	return {
		id: 'guardrail-1',
		owner_user_id: 'user-1',
		name: 'Realtime policy',
		description: null,
		status: 'active',
		designated_version: 1,
		latest_version: 1,
		created_at: '2026-08-29T00:00:00.000Z',
		updated_at: '2026-08-29T00:00:00.000Z',
		version_id: 'version-1',
		version_config_json: JSON.stringify(config),
		version_created_by_user_id: 'user-1',
		version_created_at: '2026-08-29T00:00:00.000Z',
		assignment_id: 'assignment-1',
		assignment_scope_type: 'api_key',
		assignment_scope_id: 'key-1',
	};
}

function guardrailRepositories(
	config: Record<string, unknown>,
	auditReasonCodes: string[],
): GatewayRepositories {
	return {
		guardrails: {
			getEffectiveForRequest: async () => [effectiveGuardrail(config)],
		},
		userAuditLogs: {
			insertUserAuditLog: async (event: { reasonCode: string }) => {
				auditReasonCodes.push(event.reasonCode);
			},
		},
	} as unknown as GatewayRepositories;
}

describe('DashScope realtime Guardrail budget plan', () => {
	it('forfeits transport-unknown sessions but settles success and known HTTP rejection', () => {
		const perSecondPricing = JSON.stringify({
			audio_billing_mode: 'per_second',
			audio: { price_per_second: 0.01 },
		});
		assert.equal(dashScopeRealtimeSettlementMode({
			errorMessage: 'Realtime upstream handshake failed: HTTP 502',
			initialHandshakeError: true,
			upstreamOutcomeUnknown: true,
			pricingProfileJson: perSecondPricing,
			durationSeconds: 0,
			characters: null,
			tokenUsage: null,
		}), 'forfeit');
		assert.equal(dashScopeRealtimeSettlementMode({
			errorMessage: null,
			initialHandshakeError: false,
			upstreamOutcomeUnknown: false,
			pricingProfileJson: perSecondPricing,
			durationSeconds: 1,
			durationSource: 'upstream',
			characters: null,
			tokenUsage: null,
		}), 'actual');
		assert.equal(dashScopeRealtimeSettlementMode({
			errorMessage: 'Realtime upstream handshake failed: HTTP 401',
			initialHandshakeError: true,
			upstreamOutcomeUnknown: false,
			pricingProfileJson: perSecondPricing,
			durationSeconds: 0,
			characters: null,
			tokenUsage: null,
		}), 'known_zero');
		assert.deepEqual(dashScopeRealtimeCriticalSettlement('actual'), {
			guardrailMode: 'actual',
			ordinaryUnknownCost: false,
		});
		assert.deepEqual(dashScopeRealtimeCriticalSettlement('known_zero'), {
			guardrailMode: 'actual',
			ordinaryUnknownCost: false,
		});
		assert.deepEqual(dashScopeRealtimeCriticalSettlement('forfeit'), {
			guardrailMode: 'reserved',
			ordinaryUnknownCost: true,
		});
	});

	it('preserves the realtime ceiling when success lacks the configured billing metric', () => {
		const common = {
			errorMessage: null,
			initialHandshakeError: false,
			upstreamOutcomeUnknown: false,
		} as const;
		const perSecondPricing = JSON.stringify({
			audio_billing_mode: 'per_second',
			audio: { price_per_second: 0.01 },
		});
		assert.equal(dashScopeRealtimeSettlementMode({
			...common,
			pricingProfileJson: perSecondPricing,
			durationSeconds: 0,
			characters: null,
			tokenUsage: null,
		}), 'forfeit');
		assert.equal(dashScopeRealtimeSettlementMode({
			...common,
			pricingProfileJson: perSecondPricing,
			durationSeconds: 1,
			durationSource: 'media',
			characters: null,
			tokenUsage: null,
		}), 'actual');
		assert.equal(dashScopeRealtimeSettlementMode({
			...common,
			pricingProfileJson: perSecondPricing,
			durationSeconds: 1,
			durationSource: 'client',
			characters: null,
			tokenUsage: null,
		}), 'forfeit');

		const perCharacterPricing = JSON.stringify({
			audio_billing_mode: 'per_character',
			audio: { price_per_character: 0.001 },
		});
		assert.equal(dashScopeRealtimeSettlementMode({
			...common,
			pricingProfileJson: perCharacterPricing,
			durationSeconds: 0,
			characters: null,
			tokenUsage: null,
		}), 'forfeit');
		assert.equal(dashScopeRealtimeSettlementMode({
			...common,
			pricingProfileJson: perCharacterPricing,
			durationSeconds: 0,
			characters: 0,
			tokenUsage: null,
		}), 'actual');
		assert.equal(dashScopeRealtimeSettlementMode({
			...common,
			pricingProfileJson: perCharacterPricing,
			durationSeconds: 0,
			characters: 5,
			tokenUsage: null,
		}), 'actual');

		const tokenPricing = JSON.stringify({
			audio_billing_mode: 'token',
			tiers: [{ upto: null, input_price: 1, output_price: 2 }],
		});
		assert.equal(dashScopeRealtimeSettlementMode({
			...common,
			pricingProfileJson: tokenPricing,
			durationSeconds: 0,
			characters: null,
			tokenUsage: null,
		}), 'forfeit');
		assert.equal(dashScopeRealtimeSettlementMode({
			...common,
			pricingProfileJson: tokenPricing,
			durationSeconds: 0,
			characters: null,
			tokenUsage: {
				input_tokens: 0,
				output_tokens: 0,
				audio_tokens: 0,
				text_tokens: 0,
				total_tokens: 0,
				raw_usage: {},
			},
		}), 'forfeit');
		assert.equal(dashScopeRealtimeSettlementMode({
			...common,
			pricingProfileJson: tokenPricing,
			durationSeconds: 0,
			characters: null,
			tokenUsage: {
				input_tokens: 1,
				output_tokens: 0,
				audio_tokens: 0,
				text_tokens: 1,
				total_tokens: 1,
				raw_usage: {},
			},
		}), 'actual');
	});

	it('fails closed and audits when assigned filters would need WebSocket-frame inspection', async () => {
		const inputAudit: string[] = [];
		const input = await runRequestGuardrails(guardrailRepositories({
			input_filters: [{ id: 'secret', pattern: 'secret', action: 'redact' }],
		}, inputAudit), {
			userId: 'user-1',
			apiKeyId: 'key-1',
			modelIds: ['audio/model'],
			body: { model: 'audio/model', stream: true },
			correlationId: 'realtime-input-filter',
			inputFilterSupport: 'unsupported',
		});
		assert.equal(input.ok, false);
		if (!input.ok) assert.match(input.message, /cannot safely enforce/i);
		assert.deepEqual(inputAudit, ['guardrail_blocked']);

		const outputAudit: string[] = [];
		const output = await runRequestGuardrails(guardrailRepositories({
			output_filters: [{ id: 'secret', pattern: 'secret', action: 'block' }],
		}, outputAudit), {
			userId: 'user-1',
			apiKeyId: 'key-1',
			modelIds: ['audio/model'],
			body: { model: 'audio/model', stream: true },
			correlationId: 'realtime-output-filter',
			inputFilterSupport: 'unsupported',
		});
		assert.equal(output.ok, false);
		if (!output.ok) assert.match(output.message, /streaming is disabled/i);
		assert.deepEqual(outputAudit, ['guardrail_blocked']);
	});

	it('keeps the hard session plus connection inside the dispatched lease', () => {
		assert.ok(
			DASHSCOPE_REALTIME_GUARDRAIL_LEASE_MS
				> DASHSCOPE_REALTIME_MAX_SESSION_MS + DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
		);
	});

	it('fails closed for token billing whenever a finite budget must be enforced', () => {
		const pricingProfileJson = JSON.stringify({
			audio_billing_mode: 'token',
			tiers: [{ upto: null, input_price: 1, output_price: 2 }],
		});
		assert.equal(realtimeGuardrailBudgetModeSupported({
			pricingProfileJson,
			operation: 'audio.transcriptions.realtime.inference',
			hasBudgetIntents: true,
		}).ok, false);
		assert.equal(realtimeGuardrailBudgetModeSupported({
			pricingProfileJson,
			operation: 'audio.transcriptions.realtime.inference',
			hasBudgetIntents: false,
			ordinaryBudgetIsFinite: true,
		}).ok, false);
		assert.equal(realtimeGuardrailBudgetModeSupported({
			pricingProfileJson,
			operation: 'audio.transcriptions.realtime.inference',
			hasBudgetIntents: false,
			ordinaryBudgetIsFinite: false,
		}).ok, true);
	});

	it('requires operation-matched pricing for finite budgets and accepts explicit zero prices', () => {
		const finite = {
			hasBudgetIntents: false,
			ordinaryBudgetIsFinite: true,
		} as const;
		for (const pricingProfileJson of [
			null,
			'{not-json',
			JSON.stringify({
				audio_billing_mode: 'per_character',
				audio: { price_per_character: 0.01 },
			}),
		]) {
			assert.equal(realtimeGuardrailBudgetModeSupported({
				...finite,
				operation: 'audio.transcriptions.realtime.session',
				pricingProfileJson,
			}).ok, false);
		}
		assert.equal(realtimeGuardrailBudgetModeSupported({
			...finite,
			operation: 'audio.transcriptions.realtime.inference',
			pricingProfileJson: JSON.stringify({
				audio_billing_mode: 'per_second',
				audio: { price_per_second: 0 },
			}),
		}).ok, true);

		assert.equal(realtimeGuardrailBudgetModeSupported({
			...finite,
			operation: 'audio.speech.realtime.session',
			pricingProfileJson: JSON.stringify({
				audio_billing_mode: 'per_second',
				audio: { price_per_second: 0 },
			}),
		}).ok, false);
		assert.equal(realtimeGuardrailBudgetModeSupported({
			...finite,
			operation: 'audio.speech.realtime.inference',
			pricingProfileJson: JSON.stringify({
				audio_billing_mode: 'per_character',
				audio: { price_per_character: 0 },
			}),
		}).ok, true);
	});

	it('reserves the ten-minute ceiling plus provider rounding margin and requires PCM', async () => {
		const result = await buildDashScopeRealtimeBudgetPlan(repos, {
			model: model({
				audio_billing_mode: 'per_second',
				audio: { price_per_second: 0.01 },
			}),
			baseModelId: 'audio/model',
			routes: [route()],
			operation: 'audio.transcriptions.realtime.inference',
			budgetIntents: [{
				assignmentId: 'assignment-1',
				guardrailId: 'guardrail-1',
				guardrailVersion: 1,
				scopeType: 'api_key',
				scopeId: 'key-1',
				period: 'daily',
				periodStart: '2026-01-01T00:00:00.000Z',
				periodEnd: '2026-01-02T00:00:00.000Z',
				limitMicros: 10_000_000,
			}],
			userChargedCostFactorsJson: null,
			requestStartedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
			ordinaryBudgetIsFinite: true,
			nowMs: 1_000,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.chargedCostCeiling, 6.01);
		assert.equal(result.value.reservedMicros, 6_010_000);
		assert.equal(result.value.sessionLimits.requirePcmAudio, true);
		assert.equal(result.value.sessionLimits.connectDeadlineAtMs, 31_000);
	});

	it('requires PCM for ASR even when no finite customer budget is configured', async () => {
		const result = await buildDashScopeRealtimeBudgetPlan(repos, {
			model: model({
				audio_billing_mode: 'per_second',
				audio: { price_per_second: 0.01 },
			}),
			baseModelId: 'audio/model',
			routes: [route()],
			operation: 'audio.transcriptions.realtime.inference',
			budgetIntents: [],
			userChargedCostFactorsJson: null,
			requestStartedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
			ordinaryBudgetIsFinite: false,
			nowMs: 1_000,
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.value.sessionLimits.requirePcmAudio, true);
	});
});
