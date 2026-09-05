import {
	buildEffectiveGuardrailPreview,
	evaluateGuardrailRouteEvidencePreviewWithRoutes,
	evaluateGuardrailRoutePlannerPreview,
	getBusinessTimezone,
	ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY,
	ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE,
	ROUTE_PERFORMANCE_WINDOW_MS,
	type GatewayRepositories,
} from '@octafuse/core';

const PREVIEW_ROUTE_SCAN_LIMIT = 250;
const PROVIDER_BATCH_SIZE = 100;
const ROUTE_EVIDENCE_BATCH_SIZE = 100;

function batches<T>(values: readonly T[], size: number): T[][] {
	return Array.from(
		{ length: Math.ceil(values.length / size) },
		(_, index) => values.slice(index * size, (index + 1) * size),
	);
}

export async function buildGuardrailPreviewForRequest(
	repositories: GatewayRepositories,
	params: { workspaceId: string; userId: string; apiKeyId: string | null },
) {
	const [rows, fetchedRoutes] = await Promise.all([
		repositories.guardrails.getEffectiveForRequest(
			params.workspaceId,
			params.userId,
			params.apiKeyId ?? '__guardrail_preview_without_api_key__',
		),
		repositories.routes.listModelRoutesWithJoins({ limit: PREVIEW_ROUTE_SCAN_LIMIT + 1 }),
	]);
	const preview = buildEffectiveGuardrailPreview(rows, fetchedRoutes.slice(0, PREVIEW_ROUTE_SCAN_LIMIT), {
		catalogTruncated: fetchedRoutes.length > PREVIEW_ROUTE_SCAN_LIMIT,
	});
	if (!preview.ok) return preview;

	const now = new Date();
	const routeTargetIds = preview.candidateRoutes.map((route) => route.id);
	const providerIds = [...new Set(preview.candidateRoutes.map((route) => route.provider_id))];
	const [providers, bindings, policies, businessTimezone] = await Promise.all([
		Promise.all(batches(providerIds, PROVIDER_BATCH_SIZE).map((batch) => repositories.providers.getProvidersByIds(batch))).then((rows) => rows.flat()),
		Promise.all(batches(routeTargetIds, ROUTE_EVIDENCE_BATCH_SIZE).map((batch) => repositories.modelEndpoints.listRuntimeBindingsByRouteTargetIds(batch))).then((rows) => rows.flat()),
		preview.value.routeCandidates.requiresEndpointEvidence
			? Promise.all(batches(routeTargetIds, ROUTE_EVIDENCE_BATCH_SIZE).map((batch) => repositories.routeDataPolicies.getByRouteTargetIds(batch))).then((rows) => rows.flat())
			: Promise.resolve([]),
		getBusinessTimezone(repositories),
	]);
	const routeEvidence = await evaluateGuardrailRouteEvidencePreviewWithRoutes({
		effective: preview.value.effective,
		candidateRoutes: preview.candidateRoutes,
		providers,
		policies,
		now,
	});
	const performanceRouteTargetIds = routeEvidence.eligibleRoutes
		.slice(0, ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY)
		.map((route) => route.id);
	const performanceSamples = performanceRouteTargetIds.length > 0
		? await repositories.requestLogs.getRecentRoutePerformanceSamples({
			routeTargetIds: performanceRouteTargetIds,
			sinceIso: new Date(now.getTime() - ROUTE_PERFORMANCE_WINDOW_MS).toISOString(),
			maxSamplesPerRoute: ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE,
		})
		: [];
	const plannerEvidence = await evaluateGuardrailRoutePlannerPreview({
		candidateRoutes: routeEvidence.eligibleRoutes,
		providers,
		bindings,
		performanceSamples,
		performanceRouteTargetIds,
		performanceTruncated: routeEvidence.eligibleRoutes.length > performanceRouteTargetIds.length,
		performanceWindowMs: ROUTE_PERFORMANCE_WINDOW_MS,
		pricingAt: now,
		businessTimezone,
		now,
	});

	return {
		ok: true as const,
		value: {
			...preview.value,
			routeCandidates: {
				...preview.value.routeCandidates,
				routeEvidence: routeEvidence.value,
				plannerEvidence: plannerEvidence.value,
			},
		},
	};
}
