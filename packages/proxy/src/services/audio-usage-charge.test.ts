import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories, VerifiedModelEndpointSnapshot } from '@octafuse/core';
import {
	audioGuardrailBudgetMicros,
	audioGuardrailSettlementMode,
	estimateAudioBudgetPrecheck,
	estimateAudioSpeechBudgetPrecheck,
	estimateAudioSpeechCosts,
	recordAudioUsage,
	resolveCanonicalAudioEndpointPricingOperation,
	resolveAudioUsageWriteIdentity,
} from './audio-usage-charge';
import { MAX_AUDIO_DURATION_SECONDS } from './egress/audio-duration';
import { selectConservativeMultimediaBudgetEstimate } from './multimedia-ordinary-budget';

const PROFILE = JSON.stringify({
	audio_billing_mode: 'per_character',
	audio: { price_per_character: 0.001, minimum_characters: 2 },
});

function mockRepos(): GatewayRepositories {
	return {
		systemConfig: { getConfig: async () => null },
	} as unknown as GatewayRepositories;
}

function audioEndpoint(
	pricingByOperation: NonNullable<VerifiedModelEndpointSnapshot['audioCapabilities']>['pricing_by_operation'],
): VerifiedModelEndpointSnapshot {
	return {
		id: 'endpoint-audio-1',
		modelId: 'qwen/audio',
		providerId: 'provider-audio-1',
		providerSlug: 'provider',
		selectorSlug: 'provider',
		endpointClass: 'standard',
		region: null,
		contextLength: null,
		maxPromptTokens: null,
		maxCompletionTokens: null,
		quantization: null,
		supportedParameters: [],
		pricing: null,
		capabilities: {
			implicit_caching: null,
			voice_cloning: null,
			tool_choice: { auto: null, function: null, none: null, required: null },
		},
		imageCapabilities: null,
		audioCapabilities: { v: 1, pricing_by_operation: pricingByOperation },
		evidenceUrl: 'https://evidence.example/audio',
		verifiedBy: 'auditor-1',
		verifiedAt: '2026-08-30T00:00:00.000Z',
		expiresAt: '2027-08-30T00:00:00.000Z',
	};
}

describe('verified Audio Endpoint billing', () => {
	it('accepts only exact canonical route operations for Endpoint pricing', () => {
		assert.equal(
			resolveCanonicalAudioEndpointPricingOperation('audio.transcriptions.async'),
			'audio.transcriptions.async',
		);
		assert.equal(resolveCanonicalAudioEndpointPricingOperation('*'), null);
		assert.equal(resolveCanonicalAudioEndpointPricingOperation('audio.speech '), null);
		assert.equal(resolveCanonicalAudioEndpointPricingOperation(null), null);
	});

	it('uses Endpoint character pricing instead of a conflicting legacy model profile', async () => {
		const costs = await estimateAudioSpeechCosts(mockRepos(), {
			endpoint: audioEndpoint({
				'audio.speech': {
					currency: 'USD',
					meter: {
						kind: 'characters', unit: 'unicode_code_point', price: '0.002',
						minimum_units: 0, increment_units: 1,
					},
					request: '0.1',
					discount: 0.2,
				},
			}),
			operation: 'audio.speech',
			modelPricingProfileJson: PROFILE,
			routePriceOverrideJson: JSON.stringify({ metered_factor: 1.5, charged_factor: 2 }),
			characters: 5,
			catalogModelId: 'qwen/audio',
			userChargedCostFactorsJson: JSON.stringify({ 'qwen/audio': 0.5 }),
			businessTimezone: 'UTC',
		});

		assert.equal(costs.billingKind, 'audio_per_character');
		assert.equal(costs.standardCost, 0.11);
		assert.equal(costs.meteredCost, 0.165);
		assert.equal(costs.chargedCost, 0.088);
		const audit = JSON.parse(costs.pricingAuditJson) as Record<string, unknown>;
		assert.equal(audit.endpoint_id, 'endpoint-audio-1');
		assert.equal(audit.operation, 'audio.speech');
		assert.equal(audit.user_charged_factor, 0.5);
	});

	it('uses the conservative duration ceiling for Endpoint admission', async () => {
		const costs = await estimateAudioBudgetPrecheck(mockRepos(), {
			endpoint: audioEndpoint({
				'audio.transcriptions': {
					currency: 'USD',
					meter: {
						kind: 'duration', unit: 'second', price: '0.01',
						minimum_units: 0, increment_units: 1,
					},
				},
			}),
			operation: 'audio.transcriptions',
			fileBytes: 1,
			businessTimezone: 'UTC',
		}, [JSON.stringify({ charged_factor: 2 })]);

		assert.equal(costs.durationSeconds, MAX_AUDIO_DURATION_SECONDS);
		assert.equal(costs.chargedCost, MAX_AUDIO_DURATION_SECONDS * 0.02);
		assert.doesNotMatch(costs.pricingAuditJson, /"error"/u);
	});

	it('prices transcription adapter candidates by their multimodal or async upstream tariff', async () => {
		const endpoint = audioEndpoint({
			'audio.transcriptions': {
				currency: 'USD',
				meter: {
					kind: 'duration', unit: 'second', price: '0.001',
					minimum_units: 0, increment_units: 1,
				},
			},
			'audio.transcriptions.multimodal': {
				currency: 'USD',
				meter: {
					kind: 'duration', unit: 'second', price: '0.02',
					minimum_units: 0, increment_units: 1,
				},
			},
			'audio.transcriptions.async': {
				currency: 'USD',
				meter: {
					kind: 'duration', unit: 'second', price: '0.03',
					minimum_units: 0, increment_units: 1,
				},
			},
		});

		for (const [upstreamOperation, expectedCost] of [
			['audio.transcriptions.multimodal', 0.04],
			['audio.transcriptions.async', 0.06],
		] as const) {
			const costs = await estimateAudioBudgetPrecheck(mockRepos(), {
				endpoint,
				operation: resolveCanonicalAudioEndpointPricingOperation(upstreamOperation),
				fileBytes: 1,
				verifiedDurationCeilingSeconds: 2,
				businessTimezone: 'UTC',
			}, [null]);
			assert.equal(costs.chargedCost, expectedCost);
			const audit = JSON.parse(costs.pricingAuditJson) as { operation: string };
			assert.equal(audit.operation, upstreamOperation);
		}
	});

	it('prices speech adapter candidates by the multimodal upstream tariff', async () => {
		const costs = await estimateAudioSpeechBudgetPrecheck(mockRepos(), {
			endpoint: audioEndpoint({
				'audio.speech': {
					currency: 'USD',
					meter: {
						kind: 'characters', unit: 'unicode_code_point', price: '0.001',
						minimum_units: 0, increment_units: 1,
					},
				},
				'audio.speech.multimodal': {
					currency: 'USD',
					meter: {
						kind: 'characters', unit: 'unicode_code_point', price: '0.02',
						minimum_units: 0, increment_units: 1,
					},
				},
			}),
			operation: resolveCanonicalAudioEndpointPricingOperation('audio.speech.multimodal'),
			inputCharacters: 5,
			businessTimezone: 'UTC',
		}, [null]);

		assert.equal(costs.chargedCost, 0.1);
		const audit = JSON.parse(costs.pricingAuditJson) as { operation: string };
		assert.equal(audit.operation, 'audio.speech.multimodal');
	});

	it('fails candidate admission closed when only an alternate ingress tariff exists', async () => {
		const costs = await estimateAudioBudgetPrecheck(mockRepos(), {
			endpoint: audioEndpoint({
				'audio.transcriptions': {
					currency: 'USD',
					meter: {
						kind: 'duration', unit: 'second', price: '999',
						minimum_units: 0, increment_units: 1,
					},
				},
			}),
			operation: resolveCanonicalAudioEndpointPricingOperation('audio.transcriptions.async'),
			modelPricingProfileJson: JSON.stringify({
				audio_billing_mode: 'per_second', audio: { price_per_second: 777 },
			}),
			fileBytes: 1,
			verifiedDurationCeilingSeconds: 2,
			businessTimezone: 'UTC',
		}, [null]);

		assert.equal(costs.chargedCost, 0);
		assert.match(costs.pricingAuditJson, /missing_verified_endpoint_audio_pricing/u);
		assert.equal(
			selectConservativeMultimediaBudgetEstimate([costs])?.estimatedChargedCost,
			null,
		);
	});

	it('audits unsupported Endpoint token pricing instead of falling back to legacy pricing', async () => {
		const costs = await estimateAudioBudgetPrecheck(mockRepos(), {
			endpoint: audioEndpoint({
				'audio.transcriptions': {
					currency: 'USD',
					meter: {
						kind: 'tokens', unit: 'token', require_authoritative_breakdown: true,
						rates: {
							input_audio: '0.1', input_text: '0', output_text: '0.1',
							output_audio: '0', input_audio_cache: '0',
						},
					},
				},
			}),
			operation: 'audio.transcriptions',
			modelPricingProfileJson: JSON.stringify({
				audio_billing_mode: 'per_second', audio: { price_per_second: 999 },
			}),
			fileBytes: 1,
			businessTimezone: 'UTC',
		}, [null]);

		assert.equal(costs.chargedCost, 0);
		assert.match(costs.pricingAuditJson, /unsupported_endpoint_audio_pricing_meter/u);
	});

	it('rejects settlement when the Endpoint identity or exact operation drifts', async () => {
		const endpoint = audioEndpoint({
			'audio.speech': {
				currency: 'USD',
				meter: {
					kind: 'characters', unit: 'unicode_code_point', price: '0.001',
					minimum_units: 0, increment_units: 1,
				},
			},
		});
		await assert.rejects(recordAudioUsage({
			repos: mockRepos(),
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'qwen/other', providerId: endpoint.providerId,
			requestProtocol: 'openai', requestOperation: 'audio.transcriptions',
			upstreamProtocol: 'openai', upstreamOperation: 'audio.speech',
			routeGroup: 'default', status: 'success', latencyMs: 1,
			billing: {
				endpoint,
				operation: 'audio.speech',
				durationSeconds: 0,
				characters: 1,
				businessTimezone: 'UTC',
			},
			suppressErrorAlert: true,
		}), /identity or operation does not match/u);
	});

	it('rejects settlement when billing uses the ingress tariff instead of the routed upstream tariff', async () => {
		const endpoint = audioEndpoint({
			'audio.transcriptions': {
				currency: 'USD',
				meter: {
					kind: 'duration', unit: 'second', price: '0.001',
					minimum_units: 0, increment_units: 1,
				},
			},
			'audio.transcriptions.multimodal': {
				currency: 'USD',
				meter: {
					kind: 'duration', unit: 'second', price: '0.02',
					minimum_units: 0, increment_units: 1,
				},
			},
		});

		await assert.rejects(recordAudioUsage({
			repos: mockRepos(),
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: endpoint.modelId, providerId: endpoint.providerId,
			requestProtocol: 'openai', requestOperation: 'audio.transcriptions',
			upstreamProtocol: 'dashscope', upstreamOperation: 'audio.transcriptions.multimodal',
			routeGroup: 'default', status: 'success', latencyMs: 1,
			billing: {
				endpoint,
				operation: 'audio.transcriptions',
				durationSeconds: 2,
				durationSource: 'upstream',
				businessTimezone: 'UTC',
			},
			suppressErrorAlert: true,
		}), /identity or operation does not match/u);
	});

	it('settles transcription adapters at the upstream tariff while logging the ingress operation', async () => {
		const endpoint = audioEndpoint({
			'audio.transcriptions': {
				currency: 'USD',
				meter: {
					kind: 'duration', unit: 'second', price: '0.001',
					minimum_units: 0, increment_units: 1,
				},
			},
			'audio.transcriptions.multimodal': {
				currency: 'USD',
				meter: {
					kind: 'duration', unit: 'second', price: '0.02',
					minimum_units: 0, increment_units: 1,
				},
			},
			'audio.transcriptions.async': {
				currency: 'USD',
				meter: {
					kind: 'duration', unit: 'second', price: '0.03',
					minimum_units: 0, increment_units: 1,
				},
			},
		});

		for (const [upstreamOperation, expectedCost] of [
			['audio.transcriptions.multimodal', 0.04],
			['audio.transcriptions.async', 0.06],
		] as const) {
			const batches: CapturedStatement[][] = [];
			const result = await recordAudioUsage({
				repos: captureD1AudioRepositories(batches),
				apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
				modelId: endpoint.modelId, providerId: endpoint.providerId,
				requestProtocol: 'openai', requestOperation: 'audio.transcriptions',
				upstreamProtocol: 'dashscope', upstreamOperation,
				routeGroup: 'default', status: 'success', latencyMs: 1,
				billing: {
					endpoint,
					operation: resolveCanonicalAudioEndpointPricingOperation(upstreamOperation),
					durationSeconds: 2,
					durationSource: 'upstream',
					businessTimezone: 'UTC',
				},
				suppressErrorAlert: true,
			});

			assert.equal(result.chargedCost, expectedCost);
			const insert = findRequestLogInsert(batches[0]!);
			assert.equal(requestLogColumn(insert, 'request_operation'), 'audio.transcriptions');
			assert.equal(requestLogColumn(insert, 'upstream_operation'), upstreamOperation);
		}
	});

	it('keeps passthrough settlement on the matching ingress and upstream tariff', async () => {
		const batches: CapturedStatement[][] = [];
		const endpoint = audioEndpoint({
			'audio.transcriptions': {
				currency: 'USD',
				meter: {
					kind: 'duration', unit: 'second', price: '0.01',
					minimum_units: 0, increment_units: 1,
				},
			},
		});

		const result = await recordAudioUsage({
			repos: captureD1AudioRepositories(batches),
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: endpoint.modelId, providerId: endpoint.providerId,
			requestProtocol: 'openai', requestOperation: 'audio.transcriptions',
			upstreamProtocol: 'openai', upstreamOperation: 'audio.transcriptions',
			routeGroup: 'default', status: 'success', latencyMs: 1,
			billing: {
				endpoint,
				operation: 'audio.transcriptions',
				durationSeconds: 2,
				durationSource: 'upstream',
				businessTimezone: 'UTC',
			},
			suppressErrorAlert: true,
		});

		assert.equal(result.chargedCost, 0.02);
	});

	it('settles speech adapters at the multimodal upstream tariff', async () => {
		const batches: CapturedStatement[][] = [];
		const endpoint = audioEndpoint({
			'audio.speech': {
				currency: 'USD',
				meter: {
					kind: 'characters', unit: 'unicode_code_point', price: '0.001',
					minimum_units: 0, increment_units: 1,
				},
			},
			'audio.speech.multimodal': {
				currency: 'USD',
				meter: {
					kind: 'characters', unit: 'unicode_code_point', price: '0.02',
					minimum_units: 0, increment_units: 1,
				},
			},
		});

		const result = await recordAudioUsage({
			repos: captureD1AudioRepositories(batches),
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: endpoint.modelId, providerId: endpoint.providerId,
			requestProtocol: 'openai', requestOperation: 'audio.speech',
			upstreamProtocol: 'dashscope', upstreamOperation: 'audio.speech.multimodal',
			routeGroup: 'default', status: 'success', latencyMs: 1,
			billing: {
				endpoint,
				operation: resolveCanonicalAudioEndpointPricingOperation(
					'audio.speech.multimodal',
				),
				durationSeconds: 0,
				characters: 5,
				businessTimezone: 'UTC',
			},
			suppressErrorAlert: true,
		});

		assert.equal(result.chargedCost, 0.1);
	});
});

describe('TTS per-character billing', () => {
	it('uses verified billing characters and applies the route factor', async () => {
		const costs = await estimateAudioSpeechCosts(mockRepos(), {
			modelPricingProfileJson: PROFILE,
			routePriceOverrideJson: JSON.stringify({ metered_factor: 1.5, charged_factor: 2 }),
			characters: 5,
		});
		assert.equal(costs.billingKind, 'audio_per_character');
		assert.equal(costs.characters, 5);
		assert.equal(costs.billableCharacters, 5);
		assert.equal(costs.standardCost, 0.005);
		assert.equal(costs.meteredCost, 0.0075);
		assert.equal(costs.chargedCost, 0.01);
		assert.match(costs.pricingAuditJson, /"usage_source":"validated_request_input"/);
	});

	it('audits a missing authoritative character count', async () => {
		const costs = await estimateAudioSpeechCosts(mockRepos(), {
			modelPricingProfileJson: PROFILE,
			characters: null,
		});
		assert.equal(costs.chargedCost, 0);
		assert.match(costs.pricingAuditJson, /missing_authoritative_character_count/);
	});

	it('applies user charged cost factor after route charged cost', async () => {
		const route = await estimateAudioSpeechCosts(mockRepos(), {
			modelPricingProfileJson: PROFILE,
			routePriceOverrideJson: JSON.stringify({ metered_factor: 1, charged_factor: 2 }),
			characters: 5,
			catalogModelId: 'qwen-tts',
		});
		const discounted = await estimateAudioSpeechCosts(mockRepos(), {
			modelPricingProfileJson: PROFILE,
			routePriceOverrideJson: JSON.stringify({ metered_factor: 1, charged_factor: 2 }),
			characters: 5,
			catalogModelId: 'qwen-tts',
			userChargedCostFactorsJson: JSON.stringify({ 'qwen-tts': 0.5 }),
		});
		assert.ok(Math.abs(discounted.chargedCost - route.chargedCost * 0.5) < 1e-9);
		assert.equal(discounted.meteredCost, route.meteredCost);
		const audit = JSON.parse(discounted.pricingAuditJson) as { user_charged_factor: number };
		assert.equal(audit.user_charged_factor, 0.5);
	});

	it('budget precheck uses the same user charged cost factor as the final charge', async () => {
		const override = JSON.stringify({ metered_factor: 1, charged_factor: 2 });
		const billing = {
			modelPricingProfileJson: PROFILE,
			catalogModelId: 'qwen-tts',
			userChargedCostFactorsJson: JSON.stringify({ 'qwen-tts': 0.5 }),
		};
		const precheck = await estimateAudioSpeechBudgetPrecheck(
			mockRepos(),
			{ ...billing, inputCharacters: 5 },
			[override]
		);
		const charge = await estimateAudioSpeechCosts(mockRepos(), {
			...billing,
			routePriceOverrideJson: override,
			characters: 5,
		});
		assert.equal(precheck.chargedCost, charge.chargedCost);
	});

	it('uses input length only for the budget precheck and takes the most expensive route factor', async () => {
		const costs = await estimateAudioSpeechBudgetPrecheck(
			mockRepos(),
			{ modelPricingProfileJson: PROFILE, inputCharacters: 5 },
			[
				JSON.stringify({ charged_factor: 1 }),
				JSON.stringify({ charged_factor: 3 }),
			]
		);
		assert.equal(costs.chargedCost, 0.015);
	});
});

describe('ASR admission ceiling', () => {
	it('ignores client/byte duration hints and reserves the server billing maximum', async () => {
		const costs = await estimateAudioBudgetPrecheck(
			mockRepos(),
			{
				modelPricingProfileJson: JSON.stringify({
					audio_billing_mode: 'per_second',
					audio: { price_per_second: 0.01 },
				}),
				fileBytes: 2_000,
				mimeType: 'audio/mpeg',
				clientDurationSeconds: 1,
			},
			[null],
		);
		assert.equal(costs.durationSeconds, MAX_AUDIO_DURATION_SECONDS);
		assert.equal(costs.chargedCost, MAX_AUDIO_DURATION_SECONDS * 0.01);
		assert.match(costs.pricingAuditJson, /"duration_source":"precheck"/);
	});
});

describe('audio Guardrail budget integration', () => {
	it('converts the charged precheck to a safe integer micro ceiling', () => {
		assert.equal(audioGuardrailBudgetMicros(0), 0);
		assert.equal(audioGuardrailBudgetMicros(0.0000011), 2);
		assert.equal(audioGuardrailBudgetMicros(Number.POSITIVE_INFINITY), Number.MAX_SAFE_INTEGER);
	});

	it('settles actual known usage and preserves the reservation for unknown usage', () => {
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'per_character', durationSeconds: 0,
			tokenUsage: null, characters: 12,
		}), 'actual');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'token', durationSeconds: 1,
			tokenUsage: null, characters: null,
		}), 'reserved');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'token', durationSeconds: 1,
			tokenUsage: {
				input_tokens: 0, output_tokens: 0, total_tokens: 0,
				audio_tokens: 0, text_tokens: 0, raw_usage: '{}',
			},
			characters: null,
		}), 'reserved');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'per_character', durationSeconds: 0,
			tokenUsage: null, characters: 0,
		}), 'actual');
		assert.equal(audioGuardrailSettlementMode({
			status: 'error', billingMode: 'per_second', durationSeconds: 3,
			tokenUsage: null, characters: null,
		}), 'actual');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'per_second', durationSeconds: 3,
			durationSource: 'upstream', tokenUsage: null, characters: null, usageUnavailable: true,
		}), 'reserved');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'per_character', durationSeconds: 0,
			tokenUsage: null, characters: 12, usageUnavailable: true,
		}), 'actual');
		assert.equal(audioGuardrailSettlementMode({
			status: 'error', chargeOnError: true, billingMode: 'per_second', durationSeconds: 0,
			tokenUsage: null, characters: null,
		}), 'reserved');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'per_second', durationSeconds: 3,
			durationSource: 'estimated', tokenUsage: null, characters: null,
		}), 'reserved');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'per_second', durationSeconds: 3,
			durationSource: 'upstream', tokenUsage: null, characters: null,
		}), 'actual');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'per_second', durationSeconds: 3,
			durationSource: 'media', tokenUsage: null, characters: null,
		}), 'actual');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'per_second', durationSeconds: 0,
			durationSource: 'upstream', tokenUsage: null, characters: null,
		}), 'actual');
		assert.equal(audioGuardrailSettlementMode({
			status: 'success', billingMode: 'per_second', durationSeconds: 3,
			tokenUsage: null, characters: null,
		}), 'actual');
	});

	it('pins request-log identity and budget accounting time to request start', () => {
		assert.deepEqual(resolveAudioUsageWriteIdentity({
			requestLogId: 'request-123',
			requestStartedAtMs: Date.parse('2026-08-29T23:59:59.999Z'),
		}), {
			requestLogId: 'request-123',
			budgetAccountedAt: '2026-08-29T23:59:59.999Z',
		});
	});

	it('persists authoritative provider-native audio token counts and leaves unsupported dimensions null', async () => {
		const batches: CapturedStatement[][] = [];
		await recordAudioUsage({
			repos: captureD1AudioRepositories(batches),
			requestLogId: 'audio-native-usage',
			apiKeyId: 'key-1', workspaceId: 'workspace-1', userId: 'user-1', userEmail: null,
			modelId: 'qwen/audio', providerId: 'provider-audio-1',
			requestProtocol: 'openai', requestOperation: 'audio.transcriptions',
			upstreamProtocol: 'openai', upstreamOperation: 'audio.transcriptions',
			routeGroup: 'default', status: 'success', latencyMs: 10,
			billing: {
				modelPricingProfileJson: JSON.stringify({
					audio_billing_mode: 'token',
					tiers: [{ upto: null, input_price: 1.25, output_price: 5 }],
				}),
				durationSeconds: 1,
				tokenUsage: {
					input_tokens: 17,
					output_tokens: 5,
					total_tokens: 22,
					audio_tokens: 12,
					text_tokens: 10,
					raw_usage: '{"provider":"evidence"}',
				},
			},
			suppressErrorAlert: true,
		});

		const insert = findRequestLogInsert(batches[0]!);
		assert.equal(requestLogColumn(insert, 'native_tokens_prompt'), 17);
		assert.equal(requestLogColumn(insert, 'native_tokens_completion'), 5);
		assert.equal(requestLogColumn(insert, 'native_tokens_cached'), null);
		assert.equal(requestLogColumn(insert, 'native_tokens_reasoning'), null);
		assert.equal(requestLogColumn(insert, 'native_tokens_completion_images'), null);
	});

	it('atomically records an output-blocked error while charging known upstream duration', async () => {
		const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
		const repos = captureD1AudioRepositories(batches);
		const requestId = 'audio-output-blocked';
		const result = await recordAudioUsage({
			repos,
			requestLogId: requestId,
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'qwen/asr', providerId: 'aliyun',
			sessionId: 'session-audio-1',
			requestProtocol: 'dashscope', requestOperation: 'audio.transcriptions.multimodal',
			upstreamProtocol: 'dashscope', upstreamOperation: 'audio.transcriptions.multimodal',
			routeGroup: 'default', status: 'error', chargeOnError: true,
			latencyMs: 10, errorMessage: 'Response blocked by output guardrail',
			billing: {
				modelPricingProfileJson: JSON.stringify({
					audio_billing_mode: 'per_second', audio: { price_per_second: 0.01 },
				}),
				durationSeconds: 3, durationSource: 'upstream',
				requestStartedAtMs: Date.parse('2026-08-29T01:00:00.000Z'),
			},
			guardrailBudgetSettlement: { requestId, mode: 'actual' },
			suppressErrorAlert: true,
		});

		assert.equal(result.chargedCost, 0.03);
		assert.equal(batches.length, 1);
		const insert = findRequestLogInsert(batches[0]!);
		assert.equal(requestLogColumn(insert, 'status'), 'error');
		assert.equal(requestLogColumn(insert, 'charged_cost'), 0.03);
		assert.equal(requestLogColumn(insert, 'session_id'), 'session-audio-1');
		assert.ok(batches[0]!.some(({ sql }) => sql.includes("SET state = 'settled'")));
	});

	it('atomically logs an oversized output error and settles the reserved ceiling', async () => {
		const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
		const requestId = 'audio-output-too-large';
		await recordAudioUsage({
			repos: captureD1AudioRepositories(batches),
			requestLogId: requestId,
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'qwen/asr', providerId: 'aliyun',
			requestProtocol: 'dashscope', requestOperation: 'audio.transcriptions.multimodal',
			upstreamProtocol: 'dashscope', upstreamOperation: 'audio.transcriptions.multimodal',
			routeGroup: 'default', status: 'error', latencyMs: 10,
			errorMessage: 'Response blocked by output guardrail',
			billing: {
				modelPricingProfileJson: JSON.stringify({
					audio_billing_mode: 'per_second', audio: { price_per_second: 0.01 },
				}),
				durationSeconds: 0, requestStartedAtMs: Date.parse('2026-08-29T02:00:00.000Z'),
			},
			guardrailBudgetSettlement: { requestId, usageUnavailable: true, mode: 'reserved' },
			suppressErrorAlert: true,
		});

		assert.equal(batches.length, 1);
		const insert = findRequestLogInsert(batches[0]!);
		assert.equal(requestLogColumn(insert, 'status'), 'error');
		assert.equal(requestLogColumn(insert, 'charged_cost'), 0);
		assert.ok(batches[0]!.some(({ sql }) => sql.includes("SET state = 'expired'") && sql.includes('settled_micros = reserved_micros')));
		assert.equal(batches[0]!.some(({ sql }) => sql.includes('UPDATE users SET budget_spent')), false);
	});

	it('uses one billing-certainty decision for ordinary and Guardrail settlements', async () => {
		const batches: CapturedStatement[][] = [];
		const requestId = 'audio-missing-character-usage';
		await recordAudioUsage({
			repos: captureD1AudioRepositories(batches),
			requestLogId: requestId,
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'qwen/tts', providerId: 'aliyun',
			requestProtocol: 'openai', requestOperation: 'audio.speech',
			upstreamProtocol: 'dashscope', upstreamOperation: 'audio.speech',
			routeGroup: 'default', status: 'success', latencyMs: 10,
			billing: {
				modelPricingProfileJson: PROFILE,
				durationSeconds: 0,
				characters: null,
				requestStartedAtMs: Date.parse('2026-08-29T03:00:00.000Z'),
			},
			guardrailBudgetSettlement: { requestId },
			ordinaryBudgetSettlement: {
				requestId, budgetEpoch: 7, reservedMicros: 12_000, unknownCost: false,
			},
			suppressErrorAlert: true,
		});

		const ordinaryTransition = batches[0]!.find(({ sql }) =>
			sql.includes('UPDATE user_budget_reservations') && sql.includes('SET state = ?')
		);
		assert.ok(ordinaryTransition);
		assert.equal(ordinaryTransition.values[0], 'expired');
		assert.equal(ordinaryTransition.values[1], 12_000);
		assert.ok(batches[0]!.some(({ sql }) =>
			sql.includes("SET state = 'expired'") && sql.includes('settled_micros = reserved_micros')
		));
	});

	it('settles verified TTS request characters even when optional response usage is unavailable', async () => {
		const batches: CapturedStatement[][] = [];
		const requestId = 'audio-verified-character-usage';
		await recordAudioUsage({
			repos: captureD1AudioRepositories(batches),
			requestLogId: requestId,
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'qwen/tts', providerId: 'aliyun',
			requestProtocol: 'openai', requestOperation: 'audio.speech',
			upstreamProtocol: 'dashscope', upstreamOperation: 'audio.speech',
			routeGroup: 'default', status: 'success', latencyMs: 10,
			billing: {
				modelPricingProfileJson: PROFILE,
				durationSeconds: 0,
				characters: 5,
				requestStartedAtMs: Date.parse('2026-08-29T04:00:00.000Z'),
			},
			guardrailBudgetSettlement: { requestId, usageUnavailable: true },
			ordinaryBudgetSettlement: {
				requestId, budgetEpoch: 7, reservedMicros: 12_000, unknownCost: false,
			},
			suppressErrorAlert: true,
		});

		const ordinaryTransition = batches[0]!.find(({ sql }) =>
			sql.includes('UPDATE user_budget_reservations') && sql.includes('SET state = ?')
		);
		assert.ok(ordinaryTransition);
		assert.equal(ordinaryTransition.values[0], 'settled');
		assert.equal(ordinaryTransition.values[1], 5_000);
		assert.ok(batches[0]!.some(({ sql }) => sql.includes("SET state = 'settled'")));
	});

	it('waives private BYOK charges while preserving an unknown route-inclusive key ceiling', async () => {
		const batches: CapturedStatement[][] = [];
		const requestId = 'audio-private-byok';
		const result = await recordAudioUsage({
			repos: captureD1AudioRepositories(batches, 'gateway_key_route'),
			requestLogId: requestId,
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			workspaceId: 'workspace-1',
			modelId: 'qwen/audio', providerId: 'provider-audio-1',
			requestOrigin: 'https://cinatoken.com', responseStreamed: false,
			requestProtocol: 'openai', requestOperation: 'audio.transcriptions',
			upstreamProtocol: 'openai', upstreamOperation: 'audio.transcriptions',
			routeTargetId: 'target-audio-byok',
			routeGroup: 'default', status: 'success', latencyMs: 10,
			providerKeyId: 'byok:audio-1',
			billing: {
				endpoint: audioEndpoint({
					'audio.transcriptions': {
						currency: 'USD',
						meter: {
							kind: 'duration', unit: 'second', price: '0.01',
							minimum_units: 0, increment_units: 1,
						},
					},
				}),
				operation: 'audio.transcriptions',
				durationSeconds: 3,
				durationSource: 'upstream',
				requestStartedAtMs: Date.parse('2026-09-03T01:00:00.000Z'),
			},
			guardrailBudgetSettlement: { requestId, usageUnavailable: true, mode: 'reserved' },
			ordinaryBudgetSettlement: {
				requestId, budgetEpoch: 7, reservedMicros: 30_000, unknownCost: true,
			},
			suppressErrorAlert: true,
		});

		assert.equal(result.chargedCost, 0);
		const insert = findRequestLogInsert(batches[0]!);
		assert.equal(requestLogColumn(insert, 'metered_cost'), 0);
		assert.equal(requestLogColumn(insert, 'standard_cost'), 0.03);
		assert.equal(requestLogColumn(insert, 'charged_cost'), 0);
		assert.equal(requestLogColumn(insert, 'is_byok'), 1);
		assert.equal(requestLogColumn(insert, 'charged_cost_usd'), 0);
		assert.equal(requestLogColumn(insert, 'upstream_inference_cost_usd'), 0);
		const audit = JSON.parse(String(requestLogColumn(insert, 'pricing_audit'))) as {
			byok?: Record<string, unknown>;
		};
		assert.equal(audit.byok?.policy, 'fee_waived_until_entitlement_v1');
		assert.equal(audit.byok?.standard_equivalent_cost_usd, 0.03);
		const ordinaryTransition = batches[0]!.find(({ sql }) =>
			sql.includes('UPDATE user_budget_reservations') && sql.includes('SET state = ?')
		);
		assert.equal(ordinaryTransition?.values[0], 'settled');
		assert.equal(ordinaryTransition?.values[1], 0);
		assert.ok(batches[0]!.some(({ sql }) =>
			sql.includes("SET state = 'expired'") && sql.includes('settled_micros = reserved_micros')
		));
	});
});

type CapturedStatement = { sql: string; values: unknown[] };

function captureD1AudioRepositories(
	batches: CapturedStatement[][],
	settlementBasis: 'charged' | 'gateway_key_route' = 'charged',
): GatewayRepositories {
	class Statement {
		constructor(readonly sql: string, readonly values: unknown[] = []) {}
		bind(...values: unknown[]): Statement { return new Statement(this.sql, values); }
		async first<T>(): Promise<T | null> {
			if (this.sql.includes('FROM api_key_request_logs')) return null;
			if (this.sql.includes('SELECT budget_spent_micros')) {
				return { budget_spent_micros: 1_000_000 } as T;
			}
			if (this.sql.includes('FROM user_budget_reservations')) {
				return {
					request_id: this.values[0], user_id: 'user-1', api_key_id: 'key-1',
					budget_epoch: 7, reserved_micros: 12_000, settled_micros: 0,
					state: 'dispatched',
				} as T;
			}
			return { present: 1 } as T;
		}
		async all<T>(): Promise<{ results: T[] }> {
			const gatewayKeyRoute = settlementBasis === 'gateway_key_route';
			return { results: [{
				assignment_id: gatewayKeyRoute ? 'gateway-key-limit:key-1' : 'guardrail-1',
				scope_type: gatewayKeyRoute ? 'api_key' : 'user',
				scope_id: gatewayKeyRoute ? 'key-1' : 'user-1',
				settlement_basis: settlementBasis,
			} as T] };
		}
	}
	const raw = {
		prepare(sql: string): Statement { return new Statement(sql); },
		async batch(statements: Statement[]) {
			batches.push(statements.map(({ sql, values }) => ({ sql, values })));
			return statements.map(() => ({ success: true as const, results: [], meta: { changes: 1 } }));
		},
	};
	const drizzle = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [{
						budgetSpentMicros: 1_000_000,
						budgetMax: '10', budgetPeriod: 'monthly', budgetResetAt: null,
					}],
				}),
			}),
		}),
	};
	return {
		client: { driver: 'd1', raw, drizzle },
		systemConfig: { getConfig: async () => null },
		users: { getById: async () => null },
	} as unknown as GatewayRepositories;
}

function findRequestLogInsert(batch: CapturedStatement[]): CapturedStatement {
	const statement = batch.find(({ sql }) => sql.includes('INSERT INTO api_key_request_logs'));
	assert.ok(statement);
	return statement;
}

function requestLogColumn(statement: CapturedStatement, name: string): unknown {
	const columns = /api_key_request_logs\s*\(([^)]+)\)/su.exec(statement.sql)![1]!
		.split(',')
		.map((column) => column.trim());
	return statement.values[columns.indexOf(name)];
}
