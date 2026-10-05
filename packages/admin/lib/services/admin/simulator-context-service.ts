/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { GatewayRepositories } from "@octafuse/core";
import {
	isAudioModel,
	isAudioSpeechModel,
	isAudioTranscriptionModel,
	isImageGenerationModel,
	isRerankModel,
	parseModelModalitiesJson,
	MODEL_INPUT_MODALITIES,
	MODEL_OUTPUT_MODALITIES,
} from "@octafuse/core/db/model-modalities";
import {
	BILLING_CURRENCY_KEY,
	tryParseBillingCurrencyInput,
} from "@octafuse/core/lib/billing-currency";
import { hasAdminPermission, type AdminPrincipal } from "@/lib/admin-principal";

export type SimulatorContextRepositories = {
	models: Pick<GatewayRepositories["models"], "listModelsWithRouteCounts">;
	routes: Pick<GatewayRepositories["routes"], "listModelRoutesWithJoins">;
	systemConfig: Pick<GatewayRepositories["systemConfig"], "getConfig">;
};

/** Explicit projection: never return custom parameters, prices, metadata or Provider credentials. */
function publicSurfaces(raw: string | null) {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed
		.filter(
			(value): value is Record<string, unknown> =>
				!!value && typeof value === "object" && !Array.isArray(value)
		)
		.filter((value) =>
			["id", "request_protocol", "request_operation", "status"].every(
				(field) =>
					typeof value[field] === "string" &&
					(value[field] as string).length <= 600
			)
		)
		.map((value) => ({
			id: value.id as string,
			request_protocol: value.request_protocol as string,
			request_operation: value.request_operation as string,
			status: value.status as string,
		}));
}

export async function getSimulatorContext(
	repos: SimulatorContextRepositories,
	principal: AdminPrincipal
) {
	const currency = hasAdminPermission(principal, "config.read")
		? repos.systemConfig
				.getConfig(BILLING_CURRENCY_KEY)
				.then(tryParseBillingCurrencyInput)
				.catch(() => null)
		: Promise.resolve(null);
	const [models, routes, billing_currency] = await Promise.all([
		repos.models.listModelsWithRouteCounts(),
		repos.routes.listModelRoutesWithJoins({}),
		currency,
	]);
	return {
		models: models.map((model) => ({
			id: model.id,
			display_name: model.display_name,
			vendor: model.vendor,
			audio_operation: isAudioSpeechModel(model)
				? "speech"
				: isAudioTranscriptionModel(model)
				? "transcriptions"
				: null,
			kind: isRerankModel(model)
				? "rerank"
				: isAudioModel(model)
				? "audio"
				: isImageGenerationModel(model)
				? "image"
				: "llm",
			input_modalities: (
				parseModelModalitiesJson(model.input_modalities) ?? []
			).filter((value) =>
				(MODEL_INPUT_MODALITIES as readonly string[]).includes(value)
			),
			output_modalities: (
				parseModelModalitiesJson(model.output_modalities) ?? []
			).filter((value) =>
				(MODEL_OUTPUT_MODALITIES as readonly string[]).includes(value)
			),
		})),
		routes: routes.map((route) => ({
			id: route.id,
			model_id: route.model_id,
			provider_id: route.provider_id,
			provider_model_name: route.provider_model_name,
			provider_name: route.provider_name,
			priority: route.priority,
			status: route.status,
			route_group: route.route_group,
			upstream_protocol: route.upstream_protocol,
			upstream_operation: route.upstream_operation,
			adapter: route.adapter,
			route_pool_id: route.route_pool_id,
			pool_name: route.pool_name,
			surfaces: publicSurfaces(route.surfaces),
		})),
		billing_currency,
		realtime_supported: true,
		// The Proxy financial guard currently refuses realtime TTS before upgrade.
		realtime_tts_supported: false,
		capabilities: {
			can_read_keys: hasAdminPermission(principal, "user_keys.read"),
			can_read_logs: hasAdminPermission(principal, "logs.read"),
		},
		limits: {
			image_file_bytes: 20 * 1024 * 1024,
			image_count: 5,
			audio_file_bytes: 25 * 1024 * 1024,
		},
	};
}
