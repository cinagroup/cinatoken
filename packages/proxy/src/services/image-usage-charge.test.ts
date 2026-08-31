import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	GatewayRepositories,
	ImageEndpointPricingLine,
	VerifiedModelEndpointSnapshot,
} from '@octafuse/core';
import { parsePricingProfile, resolveImageBillingMode } from '@octafuse/core';
import {
	createImagePricingContext,
	estimateImageBudgetPrecheck,
	estimateImageCosts,
	imageGuardrailBudgetMicros,
	imageGuardrailSettlementMode,
	multipleImageBillingMode,
	recordImageUsage,
	shouldChargeUncertainImageResult,
	withClientAbortPrecheckAudit,
	withUncertainResultAudit,
} from './image-usage-charge';
import { selectConservativeMultimediaBudgetEstimate } from './multimedia-ordinary-budget';

const TOKEN_PROFILE = JSON.stringify({
	tiers: [
		{
			upto: null,
			input_price: 5,
			output_price: 0,
			cache_read_price: 1.25,
			image_input_price: 8,
			image_input_cache_price: 2,
			image_output_price: 30,
		},
	],
});

const LEGACY_ONLY_PROFILE = JSON.stringify({
	tiers: [{ upto: null, input_price: 0, output_price: 0 }],
	image: {
		default: 0.053,
		by_quality_size: {
			'high:1536x1024': 0.165,
			'medium:1024x1024': 0.053,
		},
	},
});

const PER_IMAGE_PROFILE = JSON.stringify({
	image_billing_mode: 'per_image',
	image: {
		default: 0.04,
		by_quality_size: { 'high:1536x1024': 0.165 },
		input: {
			default: 0.01,
			by_quality_size: { 'high:1024x1024': 0.02 },
		},
	},
});

const LLM_PROFILE = JSON.stringify({
	tiers: [{ upto: null, input_price: 2, output_price: 12, cache_read_price: 0.2 }],
});

const CONFLICTING_PER_IMAGE_PROFILE = JSON.stringify({
	image_billing_mode: 'per_image',
	image: { default: 9 },
});

function verifiedImageEndpoint(
	pricing: ImageEndpointPricingLine[],
	patch: Partial<VerifiedModelEndpointSnapshot> = {},
): VerifiedModelEndpointSnapshot {
	return {
		id: 'endpoint-image-chosen',
		modelId: 'openai/image-endpoint-model',
		providerId: 'provider-1',
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
		imageCapabilities: {
			provider_slug: 'provider',
			provider_tag: null,
			supports_streaming: false,
			supported_parameters: {},
			allowed_passthrough_parameters: [],
			pricing,
		},
		evidenceUrl: 'https://evidence.example/endpoint-image-chosen',
		verifiedBy: 'auditor-1',
		verifiedAt: '2026-08-30T00:00:00.000Z',
		expiresAt: '2027-08-30T00:00:00.000Z',
		...patch,
	};
}

function mockRepos(): GatewayRepositories {
	return {
		systemConfig: {
			getConfig: async () => null,
		},
	} as unknown as GatewayRepositories;
}

describe('estimateImageCosts', () => {
	it('reuses one request-local timezone snapshot across precheck and settlement pricing', async () => {
		let timezoneReads = 0;
		const repos = {
			systemConfig: {
				getConfig: async () => (++timezoneReads === 1 ? 'UTC' : 'Asia/Singapore'),
			},
		} as unknown as GatewayRepositories;
		const requestStartedAtMs = Date.parse('2026-08-30T00:30:00.000Z');
		const pricingContext = await createImagePricingContext(repos, requestStartedAtMs);
		const params = {
			endpoint: verifiedImageEndpoint([
				{ billable: 'output_image' as const, unit: 'image' as const, cost_usd: '0.10' },
			]),
			routePriceOverrideJson: JSON.stringify({
				charged_factor: 1,
				schedule: {
					charged: [{ start: '00:00', end: '01:00', factor: 2 }],
				},
			}),
			imageCount: 1,
			operation: 'generations' as const,
			requestStartedAtMs,
			pricingContext,
		};

		const precheck = await estimateImageCosts(repos, params);
		const settlement = await estimateImageCosts(repos, params);
		assert.equal(timezoneReads, 1);
		assert.equal(precheck.chargedCost, 0.2);
		assert.equal(settlement.chargedCost, 0.2);
		const audit = JSON.parse(settlement.pricingAuditJson) as Record<string, unknown>;
		assert.equal(audit.pricing_at, '2026-08-30T00:30:00.000Z');
		assert.equal(audit.business_timezone, 'UTC');
	});

	it('uses the verified endpoint tariff when the legacy model profile conflicts', async () => {
		const costs = await estimateImageCosts(mockRepos(), {
			endpoint: verifiedImageEndpoint([
				{ billable: 'output_image', unit: 'image', cost_usd: '0.07' },
			]),
			modelPricingProfileJson: CONFLICTING_PER_IMAGE_PROFILE,
			routePriceOverrideJson: null,
			quality: 'high',
			size: '1536x1024',
			imageCount: 2,
			operation: 'generations',
		});

		assert.equal(costs.billingKind, 'image_per_image');
		assert.equal(costs.unitPrice, 0.07);
		assert.equal(costs.standardCost, 0.14);
		assert.equal(costs.chargedCost, 0.14);
		const audit = JSON.parse(costs.pricingAuditJson) as Record<string, unknown>;
		assert.equal(audit.source, 'verified_model_endpoint');
		assert.equal(audit.endpoint_id, 'endpoint-image-chosen');
		assert.equal(audit.standard_base_cost, 0.14);
	});

	it('applies route schedules and the user factor on the endpoint base price', async () => {
		const allDayCharged = [{ start: '00:00', end: '24:00', factor: 2 }];
		const allDayMetered = [{ start: '00:00', end: '24:00', factor: 4 }];
		const costs = await estimateImageCosts(mockRepos(), {
			endpoint: verifiedImageEndpoint([
				{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
			]),
			modelPricingProfileJson: CONFLICTING_PER_IMAGE_PROFILE,
			routePriceOverrideJson: JSON.stringify({
				charged_factor: 2,
				metered_factor: 3,
				schedule: { charged: allDayCharged, metered: allDayMetered },
			}),
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
			operation: 'generations',
			requestStartedAtMs: Date.parse('2026-08-30T12:00:00.000Z'),
			catalogModelId: 'openai/image-endpoint-model',
			userChargedCostFactorsJson: JSON.stringify({
				'openai/image-endpoint-model': 0.5,
			}),
		});

		assert.equal(costs.standardCost, 0.04);
		assert.equal(costs.meteredFactor, 12);
		assert.equal(costs.chargedFactor, 4);
		assert.equal(costs.meteredCost, 0.48);
		assert.equal(costs.chargedCost, 0.08);
		const audit = JSON.parse(costs.pricingAuditJson) as {
			endpoint_id: string;
			user_charged_factor: number;
			snapshot: {
				supplier: { effective_factor: number; cost: number };
				user_charge: { effective_factor: number; cost: number; user_charged_factor: number };
			};
		};
		assert.equal(audit.endpoint_id, 'endpoint-image-chosen');
		assert.equal(audit.snapshot.supplier.effective_factor, 12);
		assert.equal(audit.snapshot.supplier.cost, 0.48);
		assert.equal(audit.snapshot.user_charge.effective_factor, 4);
		assert.equal(audit.snapshot.user_charge.cost, 0.16);
		assert.equal(audit.user_charged_factor, 0.5);
		assert.equal(audit.snapshot.user_charge.user_charged_factor, 0.5);
	});

	it('marks empty or unsupported endpoint tariffs as unprovable estimates', async () => {
		const endpoints = [
			verifiedImageEndpoint([], { id: 'endpoint-empty' }),
			verifiedImageEndpoint([
				{ billable: 'output_image', unit: 'token', cost_usd: '0' },
			], { id: 'endpoint-unsupported' }),
		];
		for (const endpoint of endpoints) {
			const estimate = await estimateImageCosts(mockRepos(), {
				endpoint,
				modelPricingProfileJson: CONFLICTING_PER_IMAGE_PROFILE,
				routePriceOverrideJson: null,
				quality: 'auto',
				size: 'auto',
				imageCount: 1,
				operation: 'generations',
			});
			const audit = JSON.parse(estimate.pricingAuditJson) as Record<string, unknown>;
			assert.equal(estimate.chargedCost, 0);
			assert.equal(audit.source, 'verified_model_endpoint');
			assert.equal(audit.endpoint_id, endpoint.id);
			assert.equal(typeof audit.error, 'string');
			assert.equal(
				selectConservativeMultimediaBudgetEstimate([estimate])?.estimatedChargedCost,
				null,
			);
		}
	});

	it('token path: actual usage dominates charged cost (not fixed per-image)', async () => {
		const costs = await estimateImageCosts(
			mockRepos(),
			{
				modelPricingProfileJson: TOKEN_PROFILE,
				routePriceOverrideJson: null,
				quality: 'high',
				size: '1536x1024',
				imageCount: 1,
			},
			{
				usage: {
					text_tokens: 20,
					cached_text_tokens: 0,
					image_input_tokens: 0,
					cached_image_input_tokens: 0,
					image_output_tokens: 5500,
					total_tokens: 5520,
					raw_usage: '{"output_tokens":5500}',
				},
			}
		);
		assert.equal(costs.billingKind, 'image_tokens');
		assert.ok(Math.abs(costs.chargedCost - 0.1651) < 1e-6);
		assert.equal(costs.logTokens.outputTokens, 5500);
		assert.equal(costs.logImageCounts?.outputImageCount, 0);
		assert.ok(costs.pricingAuditJson.includes('"kind":"image_tokens"'));
	});

	it('token path precheck is conservative vs short generations', async () => {
		const precheck = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: TOKEN_PROFILE,
			routePriceOverrideJson: null,
			quality: 'high',
			size: '1536x1024',
			imageCount: 1,
			isEdit: false,
		});
		const shortGen = await estimateImageCosts(
			mockRepos(),
			{
				modelPricingProfileJson: TOKEN_PROFILE,
				routePriceOverrideJson: null,
				quality: 'high',
				size: '1536x1024',
				imageCount: 1,
			},
			{
				usage: {
					text_tokens: 15,
					cached_text_tokens: 0,
					image_input_tokens: 0,
					cached_image_input_tokens: 0,
					image_output_tokens: 5500,
					total_tokens: 5515,
					raw_usage: null,
				},
			}
		);
		assert.equal(precheck.billingKind, 'image_tokens');
		assert.ok(precheck.chargedCost >= shortGen.chargedCost);
	});

	it('legacy per-image-only profile no longer bills', async () => {
		const costs = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: LEGACY_ONLY_PROFILE,
			routePriceOverrideJson: null,
			quality: 'high',
			size: '1536x1024',
			imageCount: 1,
		});
		assert.equal(costs.billingKind, 'image_tokens');
		assert.equal(costs.chargedCost, 0);
		assert.ok(costs.pricingAuditJson.includes('missing_image_pricing'));
	});

	it('explicit per_image mode bills by output count', async () => {
		const costs = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: null,
			quality: 'high',
			size: '1536x1024',
			imageCount: 1,
			operation: 'generations',
		});
		assert.equal(costs.billingKind, 'image_per_image');
		assert.ok(Math.abs(costs.chargedCost - 0.165) < 1e-9);
		assert.equal(costs.unitPrice, 0.165);
		assert.equal(costs.logTokens.totalTokens, 0);
		assert.equal(costs.logImageCounts?.outputImageCount, 1);
		assert.equal(costs.logImageCounts?.inputImageCount, 0);
		assert.ok(costs.pricingAuditJson.includes('"kind":"image_per_image"'));
		assert.ok(costs.pricingAuditJson.includes('"output_unit_price":0.165'));
	});

	it('per_image adds input.default × referenceCount', async () => {
		const costs = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: null,
			quality: 'high',
			size: '1536x1024',
			imageCount: 1,
			referenceCount: 2,
		});
		assert.equal(costs.billingKind, 'image_per_image');
		// output high:1536x1024 = 0.165; input 无匹配档 → default 0.01 × 2 refs
		assert.ok(Math.abs(costs.chargedCost - (0.165 + 0.01 * 2)) < 1e-9);
		assert.equal(costs.logImageCounts?.inputImageCount, 2);
		assert.equal(costs.logImageCounts?.outputImageCount, 1);
	});

	it('per_image override schedule uses window factor instead of multiplying', async () => {
		const allDay = [{ start: '00:00', end: '24:00', factor: 2 }];
		const multiply = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: JSON.stringify({
				charged_factor: 1.5,
				metered_factor: 1,
				schedule: { charged: allDay, metered: allDay },
			}),
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
		});
		const override = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: JSON.stringify({
				charged_factor: 1.5,
				metered_factor: 1,
				schedule: { mode: 'override', charged: allDay, metered: allDay },
			}),
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
		});
		const base = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: null,
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
		});
		assert.ok(Math.abs(multiply.chargedCost - base.chargedCost * 3) < 1e-9);
		assert.ok(Math.abs(override.chargedCost - base.chargedCost * 2) < 1e-9);
	});

	it('applies user charged cost factor after route charged cost', async () => {
		const route = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: JSON.stringify({ charged_factor: 2, metered_factor: 1 }),
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
			catalogModelId: 'gpt-image-1',
		});
		const discounted = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: JSON.stringify({ charged_factor: 2, metered_factor: 1 }),
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
			catalogModelId: 'gpt-image-1',
			userChargedCostFactorsJson: JSON.stringify({ 'gpt-image-1': 0.5 }),
		});
		assert.ok(Math.abs(discounted.chargedCost - route.chargedCost * 0.5) < 1e-9);
		assert.equal(discounted.meteredCost, route.meteredCost);
		const audit = JSON.parse(discounted.pricingAuditJson) as { user_charged_factor: number };
		assert.equal(audit.user_charged_factor, 0.5);
	});

	it('per_image applies charged_factor from route override', async () => {
		const base = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: null,
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
		});
		const doubled = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: JSON.stringify({ charged_factor: 2, metered_factor: 1 }),
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
		});
		assert.equal(base.billingKind, 'image_per_image');
		assert.ok(Math.abs(doubled.chargedCost - base.chargedCost * 2) < 1e-9);
	});

	it('LLM profile without image prices yields zero image cost', async () => {
		const costs = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: LLM_PROFILE,
			routePriceOverrideJson: null,
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
		});
		assert.equal(costs.chargedCost, 0);
	});

	it('budget precheck uses max charged_factor across failover routes', async () => {
		const cheap = JSON.stringify({ charged_factor: 1, metered_factor: 1 });
		const expensive = JSON.stringify({ charged_factor: 2, metered_factor: 1 });
		const withCheapOnly = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: TOKEN_PROFILE,
			routePriceOverrideJson: cheap,
			quality: 'high',
			size: '1536x1024',
			imageCount: 1,
		});
		const precheck = await estimateImageBudgetPrecheck(
			mockRepos(),
			{
				modelPricingProfileJson: TOKEN_PROFILE,
				quality: 'high',
				size: '1536x1024',
				imageCount: 1,
			},
			[cheap, expensive]
		);
		assert.ok(precheck.chargedCost > withCheapOnly.chargedCost);
		assert.ok(Math.abs(precheck.chargedCost - withCheapOnly.chargedCost * 2) < 1e-6);
	});

	it('auto/unknown quality precheck uses upper-bound output tokens', async () => {
		const auto = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: TOKEN_PROFILE,
			routePriceOverrideJson: null,
			quality: 'auto',
			size: '1024x1024',
			imageCount: 1,
		});
		const high = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: TOKEN_PROFILE,
			routePriceOverrideJson: null,
			quality: 'high',
			size: '1024x1024',
			imageCount: 1,
		});
		const medium = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: TOKEN_PROFILE,
			routePriceOverrideJson: null,
			quality: 'medium',
			size: '1024x1024',
			imageCount: 1,
		});
		assert.ok(Math.abs(auto.chargedCost - high.chargedCost) < 1e-9);
		assert.ok(auto.chargedCost > medium.chargedCost);
	});
});

describe('image Guardrail budget integration', () => {
	it('converts the highest charged precheck to safe integer micros', () => {
		assert.equal(imageGuardrailBudgetMicros({ chargedCost: 0 }), 0);
		assert.equal(imageGuardrailBudgetMicros({ chargedCost: 0.0000001 }), 1);
		assert.equal(imageGuardrailBudgetMicros({ chargedCost: 0.123456 }), 123_456);
		assert.equal(
			imageGuardrailBudgetMicros({ chargedCost: Number.MAX_VALUE }),
			Number.MAX_SAFE_INTEGER,
		);
	});

	it('keeps the lease only when a successful token-priced response lacks usage', () => {
		assert.equal(imageGuardrailSettlementMode({
			status: 'success', tokenPriced: true, imageUsage: null,
		}), 'reserved');
		assert.equal(imageGuardrailSettlementMode({
			status: 'error', tokenPriced: true, imageUsage: null,
		}), 'actual');
		assert.equal(imageGuardrailSettlementMode({
			status: 'success', tokenPriced: false, imageUsage: null,
		}), 'actual');
		assert.equal(imageGuardrailSettlementMode({
			status: 'success', tokenPriced: true, imageUsage: {
				text_tokens: 0,
				cached_text_tokens: 0,
				image_input_tokens: 0,
				cached_image_input_tokens: 0,
				image_output_tokens: 0,
				total_tokens: 0,
				raw_usage: '{}',
			},
		}), 'reserved');
		assert.equal(imageGuardrailSettlementMode({
			status: 'success', tokenPriced: true, imageUsage: {
				text_tokens: 0,
				cached_text_tokens: 0,
				image_input_tokens: 0,
				cached_image_input_tokens: 0,
				image_output_tokens: 1,
				total_tokens: 1,
				raw_usage: null,
			},
		}), 'actual');
		assert.equal(imageGuardrailSettlementMode({
			status: 'error', tokenPriced: false, imageUsage: null,
			upstreamAccepted: true, resultConfirmed: false,
		}), 'reserved');
		assert.equal(imageGuardrailSettlementMode({
			status: 'error', tokenPriced: true, imageUsage: null,
			upstreamAccepted: true, resultConfirmed: false, clientOutcomeBillable: false,
		}), 'actual');
	});

	it('admits n > 1 only with an explicit per-image or image-token settlement basis', () => {
		assert.equal(multipleImageBillingMode(TOKEN_PROFILE), 'token');
		assert.equal(multipleImageBillingMode(PER_IMAGE_PROFILE), 'per_image');
		assert.equal(multipleImageBillingMode(null), null);
		assert.equal(multipleImageBillingMode(JSON.stringify({ image: { default: 0.04 } })), null);
		assert.equal(multipleImageBillingMode(JSON.stringify({ tiers: [{
			upto: null, input_price: 1, output_price: 2,
		}]})), null);
	});

	it('writes the fixed request id, accounted-at instant, and atomic settlement', async () => {
		type CapturedStatement = { sql: string; values: unknown[] };
		const batches: CapturedStatement[][] = [];
		class Statement {
			constructor(
				readonly sql: string,
				readonly values: unknown[] = [],
			) {}
			bind(...values: unknown[]): Statement {
				return new Statement(this.sql, values);
			}
			async first<T>(): Promise<T | null> {
				return { present: 1 } as T;
			}
		}
		const raw = {
			prepare(sql: string): Statement {
				return new Statement(sql);
			},
			async batch(statements: Statement[]): Promise<Array<{ success: true; results: []; meta: { changes: number } }>> {
				batches.push(statements.map(({ sql, values }) => ({ sql, values })));
				return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
			},
		};
		const repos = {
			client: { driver: 'd1', raw, drizzle: {} },
			systemConfig: { getConfig: async () => null },
		} as unknown as GatewayRepositories;
		const requestId = 'image-request-fixed';
		const accountedAt = '2026-08-29T23:59:59.000Z';

		const result = await recordImageUsage({
			repos,
			requestLogId: requestId,
			budgetAccountedAt: accountedAt,
			guardrailBudgetSettlement: { requestId },
			apiKeyId: 'key-1', userId: 'user-1', userEmail: 'user@example.com',
			modelId: 'openai/image-free', providerId: 'provider-1',
			requestProtocol: 'openai', requestOperation: 'images.generations',
			upstreamProtocol: 'openai', routeGroup: 'default', status: 'success', latencyMs: 10,
			billing: { modelPricingProfileJson: null, imageCount: 1, operation: 'generations' },
			effectiveImageCount: 1, imageUsage: null, resultConfirmed: true,
			suppressErrorAlert: true,
		});

		assert.equal(result.requestLogId, requestId);
		assert.equal(batches.length, 1);
		const requestInsert = batches[0]!.find((statement) =>
			statement.sql.includes('INSERT INTO api_key_request_logs')
		);
		assert.ok(requestInsert);
		const columns = /api_key_request_logs\s*\(([^)]+)\)/su.exec(requestInsert!.sql)![1]!
			.split(',')
			.map((column) => column.trim());
		assert.equal(requestInsert!.values[columns.indexOf('id')], requestId);
		assert.equal(requestInsert!.values[columns.indexOf('budget_accounted_at')], accountedAt);
		const settlement = batches[0]!.find((statement) =>
			statement.sql.includes("SET state = 'settled'")
		);
		assert.ok(settlement);
		assert.ok(settlement!.values.includes(requestId));
	});

	it('preserves both budget ceilings for a consumed but unusable 2xx result', async () => {
		const batches: ImageCapturedStatement[][] = [];
		const requestId = 'image-consumed-unusable';
		await recordImageUsage({
			repos: captureD1ImageRepositories(batches),
			requestLogId: requestId,
			guardrailBudgetSettlement: { requestId },
			ordinaryBudgetSettlement: {
				requestId, budgetEpoch: 7, reservedMicros: 200_000, unknownCost: false,
			},
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'openai/image', providerId: 'provider-1',
			requestProtocol: 'openai', requestOperation: 'images.generations',
			upstreamProtocol: 'openai', routeGroup: 'default', status: 'error', latencyMs: 10,
			errorMessage: 'Upstream returned no image data',
			billing: {
				modelPricingProfileJson: PER_IMAGE_PROFILE,
				imageCount: 1,
				operation: 'generations',
			},
			effectiveImageCount: 0,
			imageUsage: null,
			resultConfirmed: false,
			upstreamAccepted: true,
			suppressErrorAlert: true,
		});

		const ordinaryTransition = batches[0]!.find(({ sql }) =>
			sql.includes('UPDATE user_budget_reservations') && sql.includes('SET state = ?')
		);
		assert.ok(ordinaryTransition);
		assert.equal(ordinaryTransition.values[0], 'expired');
		assert.equal(ordinaryTransition.values[1], 200_000);
		assert.ok(batches[0]!.some(({ sql }) =>
			sql.includes("SET state = 'expired'") && sql.includes('settled_micros = reserved_micros')
		));
	});

	it('preserves a Guardrail-only ceiling for independent transport uncertainty', async () => {
		const batches: ImageCapturedStatement[][] = [];
		const requestId = 'image-guardrail-only-unknown';
		await recordImageUsage({
			repos: captureD1ImageRepositories(batches),
			requestLogId: requestId,
			guardrailBudgetSettlement: { requestId, mode: 'reserved' },
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'openai/image', providerId: 'provider-1',
			requestProtocol: 'openai', requestOperation: 'images.generations',
			upstreamProtocol: 'openai', routeGroup: 'default', status: 'error', latencyMs: 10,
			errorMessage: 'Image upstream outcome unknown',
			billing: { modelPricingProfileJson: TOKEN_PROFILE, imageCount: 1 },
			effectiveImageCount: 0,
			imageUsage: null,
			resultConfirmed: false,
			suppressErrorAlert: true,
		});

		assert.equal(batches[0]!.some(({ sql }) => sql.includes('UPDATE user_budget_reservations')), false);
		assert.ok(batches[0]!.some(({ sql }) =>
			sql.includes("SET state = 'expired'") && sql.includes('settled_micros = reserved_micros')
		));
	});

	it('clamps provider overproduction to the admitted image count and preserves both ceilings', async () => {
		const batches: ImageCapturedStatement[][] = [];
		const requestId = 'image-output-count-overrun';
		const result = await recordImageUsage({
			repos: captureD1ImageRepositories(batches),
			requestLogId: requestId,
			guardrailBudgetSettlement: { requestId },
			ordinaryBudgetSettlement: {
				requestId, budgetEpoch: 7, reservedMicros: 200_000, unknownCost: false,
			},
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'openai/image-endpoint-model', providerId: 'provider-1',
			requestProtocol: 'openai', requestOperation: 'images.generations',
			upstreamProtocol: 'openai', routeGroup: 'default', status: 'success', latencyMs: 10,
			billing: {
				endpoint: verifiedImageEndpoint([
					{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
				], { id: 'endpoint-image-overrun' }),
				modelPricingProfileJson: CONFLICTING_PER_IMAGE_PROFILE,
				imageCount: 1,
				operation: 'generations',
			},
			effectiveImageCount: 2,
			imageUsage: null,
			resultConfirmed: true,
			upstreamAccepted: true,
			suppressErrorAlert: true,
		});

		assert.equal(result.chargedCost, 0.04);
		const insert = findImageRequestLogInsert(batches[0]!);
		assert.equal(imageRequestLogColumn(insert, 'output_image_count'), 1);
		const audit = JSON.parse(String(imageRequestLogColumn(insert, 'pricing_audit'))) as Record<string, unknown>;
		assert.equal(audit.endpoint_id, 'endpoint-image-overrun');
		assert.equal(audit.admitted_output_image_count, 1);
		assert.equal(audit.observed_output_image_count, 2);
		assert.equal(audit.output_count_clamped, true);
		assert.equal(audit.settlement_basis, 'admission_ceiling');
		const ordinaryTransition = batches[0]!.find(({ sql }) =>
			sql.includes('UPDATE user_budget_reservations') && sql.includes('SET state = ?')
		);
		assert.equal(ordinaryTransition?.values[0], 'expired');
		assert.ok(batches[0]!.some(({ sql }) =>
			sql.includes("SET state = 'expired'") && sql.includes('settled_micros = reserved_micros')
		));
	});

	it('settles actual underproduction from the chosen endpoint identity', async () => {
		const batches: ImageCapturedStatement[][] = [];
		const endpoint = verifiedImageEndpoint([
			{ billable: 'output_image', unit: 'image', cost_usd: '0.06' },
		], {
			id: 'endpoint-image-actual',
			providerId: 'provider-actual',
			evidenceUrl: 'https://evidence.example/endpoint-image-actual',
		});
		const result = await recordImageUsage({
			repos: captureD1ImageRepositories(batches),
			requestLogId: 'image-underproduction',
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'openai/image-endpoint-model', providerId: 'provider-actual',
			requestProtocol: 'openai', requestOperation: 'images.generations',
			upstreamProtocol: 'openai', routeGroup: 'default', status: 'success', latencyMs: 10,
			billing: {
				endpoint,
				modelPricingProfileJson: CONFLICTING_PER_IMAGE_PROFILE,
				imageCount: 3,
				operation: 'generations',
			},
			effectiveImageCount: 2,
			imageUsage: null,
			resultConfirmed: true,
			upstreamAccepted: true,
			suppressErrorAlert: true,
		});

		assert.equal(result.chargedCost, 0.12);
		const insert = findImageRequestLogInsert(batches[0]!);
		assert.equal(imageRequestLogColumn(insert, 'output_image_count'), 2);
		const audit = JSON.parse(String(imageRequestLogColumn(insert, 'pricing_audit'))) as Record<string, unknown>;
		assert.equal(audit.source, 'verified_model_endpoint');
		assert.equal(audit.endpoint_id, 'endpoint-image-actual');
		assert.equal(audit.evidence_url, 'https://evidence.example/endpoint-image-actual');
		assert.equal(audit.output_image_count, 2);
		assert.equal(audit.standard_base_cost, 0.12);
	});

	it('rejects a settlement whose endpoint identity does not match the chosen route log', async () => {
		await assert.rejects(recordImageUsage({
			repos: mockRepos(),
			apiKeyId: 'key-1', userId: 'user-1', userEmail: null,
			modelId: 'openai/image-endpoint-model', providerId: 'provider-wrong',
			requestProtocol: 'openai', requestOperation: 'images.generations',
			upstreamProtocol: 'openai', routeGroup: 'default', status: 'success', latencyMs: 1,
			billing: {
				endpoint: verifiedImageEndpoint([
					{ billable: 'output_image', unit: 'image', cost_usd: '0.04' },
				]),
				imageCount: 1,
				operation: 'generations',
			},
			effectiveImageCount: 1,
			resultConfirmed: true,
			suppressErrorAlert: true,
		}), /endpoint pricing identity does not match routed usage/);
	});
});

describe('missing upstream usage fallback', () => {
	it('precheck fallback bills conservatively and audits reason', async () => {
		const fallback = await estimateImageCosts(
			mockRepos(),
			{
				modelPricingProfileJson: TOKEN_PROFILE,
				routePriceOverrideJson: null,
				quality: 'high',
				size: '1536x1024',
				imageCount: 1,
			},
			{
				auditExtra: { usage_source: 'precheck_fallback', error: 'missing_upstream_usage' },
			}
		);
		assert.ok(fallback.chargedCost > 0);
		assert.ok(fallback.pricingAuditJson.includes('missing_upstream_usage'));
		assert.ok(fallback.pricingAuditJson.includes('precheck_fallback'));
	});
});

describe('uncertain result precheck audit', () => {
	it('tags budget precheck with client_abort_precheck without changing cost', async () => {
		const precheck = await estimateImageBudgetPrecheck(
			mockRepos(),
			{
				modelPricingProfileJson: TOKEN_PROFILE,
				quality: 'high',
				size: '1024x1024',
				imageCount: 1,
				isEdit: false,
			},
			[null]
		);
		assert.ok(precheck.chargedCost > 0);
		const audited = withClientAbortPrecheckAudit(precheck);
		assert.equal(audited.chargedCost, precheck.chargedCost);
		assert.equal(audited.meteredCost, precheck.meteredCost);
		assert.ok(audited.pricingAuditJson.includes('client_abort_precheck'));
	});

	it('supports gateway_timeout_precheck audit source', async () => {
		const precheck = await estimateImageCosts(mockRepos(), {
			modelPricingProfileJson: PER_IMAGE_PROFILE,
			routePriceOverrideJson: null,
			quality: 'auto',
			size: 'auto',
			imageCount: 1,
		});
		const audited = withUncertainResultAudit(precheck, 'gateway_timeout_precheck');
		assert.equal(audited.chargedCost, precheck.chargedCost);
		assert.ok(audited.pricingAuditJson.includes('gateway_timeout_precheck'));
	});
});

describe('shouldChargeUncertainImageResult', () => {
	const tokenProfile = parsePricingProfile(TOKEN_PROFILE);
	const perImageRequested = parsePricingProfile(PER_IMAGE_PROFILE);
	const perImageZero = parsePricingProfile(
		JSON.stringify({
			image_billing_mode: 'per_image',
			image: { default: 0.04, uncertain_result_policy: 'zero' },
		})
	);
	const tokenPrecheck = { chargedCost: 0.98 };

	it('does not charge token-mode client abort even when precheck > 0', () => {
		assert.equal(
			shouldChargeUncertainImageResult({
				status: 'error',
				mode: resolveImageBillingMode(tokenProfile),
				profile: tokenProfile,
				imageAbortReason: 'client_abort',
				clientAbortPrecheck: tokenPrecheck,
			}),
			false
		);
	});

	it('does not charge token-mode gateway timeout even when precheck > 0', () => {
		assert.equal(
			shouldChargeUncertainImageResult({
				status: 'error',
				mode: resolveImageBillingMode(tokenProfile),
				profile: tokenProfile,
				imageAbortReason: 'gateway_timeout',
				clientAbortPrecheck: tokenPrecheck,
			}),
			false
		);
	});

	it('does not charge explicit upstream 5xx / network 502 (error without abort)', () => {
		assert.equal(
			shouldChargeUncertainImageResult({
				status: 'error',
				mode: resolveImageBillingMode(tokenProfile),
				profile: tokenProfile,
				imageAbortReason: null,
				clientAbortPrecheck: null,
			}),
			false
		);
		assert.equal(
			shouldChargeUncertainImageResult({
				status: 'error',
				mode: resolveImageBillingMode(perImageRequested),
				profile: perImageRequested,
				imageAbortReason: null,
				clientAbortPrecheck: null,
			}),
			false
		);
	});

	it('does not charge per_image abort even when uncertain_result_policy is requested', () => {
		assert.equal(
			shouldChargeUncertainImageResult({
				status: 'error',
				mode: resolveImageBillingMode(perImageRequested),
				profile: perImageRequested,
				imageAbortReason: 'client_abort',
				clientAbortPrecheck: { chargedCost: 0.04 },
			}),
			false
		);
	});

	it('does not charge per_image abort when uncertain_result_policy is zero', () => {
		assert.equal(
			shouldChargeUncertainImageResult({
				status: 'error',
				mode: resolveImageBillingMode(perImageZero),
				profile: perImageZero,
				imageAbortReason: 'gateway_timeout',
				clientAbortPrecheck: { chargedCost: 0.04 },
			}),
			false
		);
	});
});

type ImageCapturedStatement = { sql: string; values: unknown[] };

function captureD1ImageRepositories(batches: ImageCapturedStatement[][]): GatewayRepositories {
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
					budget_epoch: 7, reserved_micros: 200_000, settled_micros: 0,
					state: 'dispatched',
				} as T;
			}
			return { present: 1 } as T;
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

function findImageRequestLogInsert(batch: ImageCapturedStatement[]): ImageCapturedStatement {
	const statement = batch.find(({ sql }) => sql.includes('INSERT INTO api_key_request_logs'));
	assert.ok(statement);
	return statement;
}

function imageRequestLogColumn(statement: ImageCapturedStatement, name: string): unknown {
	const columns = /api_key_request_logs\s*\(([^)]+)\)/su.exec(statement.sql)![1]!
		.split(',')
		.map((column) => column.trim());
	return statement.values[columns.indexOf(name)];
}
