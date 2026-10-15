import { useMemo } from 'react';
import { useAdvancedEditorRequest } from '@/components/routing-workbench/AdvancedEditorGate';
import { readApiJson } from "@/lib/api-json";
import type {
	GatewayModel,
	GatewayProvider,
	SystemConfigRow,
} from "@/lib/types";
import { isRouteStrategyName } from "@octafuse/core/db/model-route-policy";
import { ROUTE_STRATEGY_KEY } from "@octafuse/core/lib/route-strategy-system-config";
import { buildRouteSavePayload } from "./route-utils";
import type {
	RouteFormData,
	RouteListRow,
	RoutesPageData,
	StickyBindingLookup,
	StickyBindingsSummary,
} from "./types";

export async function fetchRoutesPageData(request: typeof fetch = fetch): Promise<RoutesPageData> {
	const [routesRes, modelsRes, providersRes, configRes] = await Promise.all([
		request("/api/admin/routes"),
		request("/api/admin/models"),
		request("/api/admin/providers"),
		request("/api/admin/config"),
	]);
	const routesData = await readApiJson<RouteListRow[]>(routesRes);
	const modelsData = await readApiJson<GatewayModel[]>(modelsRes);
	const providersData = await readApiJson<GatewayProvider[]>(providersRes);
	const configData = await readApiJson<SystemConfigRow[]>(configRes);
	const globalStrategyRaw = configData.success
		? configData.data
				?.find((row) => row.key === ROUTE_STRATEGY_KEY)
				?.value?.trim()
				.toLowerCase()
		: null;

	return {
		routes: routesData.success ? routesData.data || [] : [],
		models: modelsData.success ? modelsData.data || [] : [],
		providers: providersData.success
			? [...(providersData.data || [])].sort((a, b) =>
					a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
			  )
			: [],
		globalRouteStrategy:
			globalStrategyRaw && isRouteStrategyName(globalStrategyRaw)
				? globalStrategyRaw
				: null,
	};
}

export async function saveRoute(
	formData: RouteFormData,
	editingRoute: RouteListRow | null, request: typeof fetch = fetch
): Promise<{ success: true } | { success: false; message: string }> {
	try {
		const payload = buildRouteSavePayload(formData, editingRoute);
		let response: Response;
		if (editingRoute) {
			response = await request(
				`/api/admin/routes/${encodeURIComponent(editingRoute.id)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				}
			);
		} else {
			response = await request("/api/admin/routes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
		}
		const data = await readApiJson(response);
		if (data.success) return { success: true };
		return { success: false, message: data.message || "Save failed" };
	} catch (error) {
		return {
			success: false,
			message:
				error instanceof Error
					? error.message
					: "Save failed, please try again",
		};
	}
}

export async function deleteRoute(
	id: string, request: typeof fetch = fetch
): Promise<{ success: true } | { success: false; message: string }> {
	const response = await request(`/api/admin/routes/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return { success: false, message: data.message || "Delete failed" };
}

export async function toggleRouteStatus(
	id: string,
	status: "active" | "inactive", request: typeof fetch = fetch
): Promise<{ success: true } | { success: false; message: string }> {
	const response = await request(`/api/admin/routes/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status }),
	});
	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return { success: false, message: data.message || "Update failed" };
}

export async function patchModelRoutePolicy(
	modelId: string,
	routePolicy: string | null, expectedRoutePolicy: string | null, request: typeof fetch = fetch
): Promise<{ success: true } | { success: false; message: string }> {
	const response = await request(
		`/api/admin/models/${encodeURIComponent(modelId)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ route_policy: routePolicy, expected_route_policy: expectedRoutePolicy }),
		}
	);
	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return {
		success: false,
		message: data.message || "Save failed, please try again",
	};
}

export async function patchRoutePoolStrategy(
	poolId: string,
	strategy: string | null, request: typeof fetch = fetch
): Promise<{ success: true } | { success: false; message: string }> {
	return patchRoutePoolPolicy(poolId, { strategy }, request);
}

export async function patchRoutePoolPolicy(
	poolId: string,
	patch: {
		strategy?: string | null;
		tier_strategies?: string | null | Record<string, string>;
		sticky_routing?: { enabled: boolean; idle_ttl_seconds: number };
	}, request: typeof fetch = fetch
): Promise<{ success: true } | { success: false; message: string }> {
	const response = await request(
		`/api/admin/routes/pools/${encodeURIComponent(poolId)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		}
	);
	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return {
		success: false,
		message: data.message || "Save failed, please try again",
	};
}

export async function fetchStickyBindingsSummary(
	poolId: string, request: typeof fetch = fetch
): Promise<
	| { success: true; data: StickyBindingsSummary }
	| { success: false; message: string }
> {
	const response = await request(
		`/api/admin/routes/pools/${encodeURIComponent(
			poolId
		)}/sticky/bindings/summary`
	);
	const data = await readApiJson<StickyBindingsSummary>(response);
	if (data.success && data.data) return { success: true, data: data.data };
	return {
		success: false,
		message: data.message || "Failed to load sticky bindings summary",
	};
}

export async function lookupStickyBinding(params: {
	poolId: string;
	modelId: string;
	routeGroup: string;
	protocol: string;
	requestOperation: string;
	userId?: string;
	email?: string;
}, request: typeof fetch = fetch): Promise<
	| { success: true; data: StickyBindingLookup }
	| { success: false; message: string }
> {
	const qs = new URLSearchParams({
		model_id: params.modelId,
		route_group: params.routeGroup,
		protocol: params.protocol,
		request_operation: params.requestOperation,
	});
	if (params.userId?.trim()) qs.set("user_id", params.userId.trim());
	if (params.email?.trim()) qs.set("email", params.email.trim());
	const response = await request(
		`/api/admin/routes/pools/${encodeURIComponent(
			params.poolId
		)}/sticky/bindings/lookup?${qs}`
	);
	const data = await readApiJson<StickyBindingLookup>(response);
	if (data.success && data.data) return { success: true, data: data.data };
	return {
		success: false,
		message: data.message || "Failed to lookup sticky binding",
	};
}

export async function clearStickyBinding(
	poolId: string,
	affinityHash: string, request: typeof fetch = fetch
): Promise<
	{ success: true; cleared: boolean } | { success: false; message: string }
> {
	const response = await request(
		`/api/admin/routes/pools/${encodeURIComponent(
			poolId
		)}/sticky/bindings/${encodeURIComponent(affinityHash)}`,
		{ method: "DELETE" }
	);
	const data = await readApiJson<{ cleared: boolean }>(response);
	if (data.success)
		return { success: true, cleared: Boolean(data.data?.cleared) };
	return {
		success: false,
		message: data.message || "Failed to clear sticky binding",
	};
}

export async function resetStickyBindings(
	poolId: string, request: typeof fetch = fetch
): Promise<
	{ success: true; sticky_epoch: number } | { success: false; message: string }
> {
	const response = await request(
		`/api/admin/routes/pools/${encodeURIComponent(poolId)}/sticky/reset`,
		{ method: "POST" }
	);
	const data = await readApiJson<{ sticky_epoch: number }>(response);
	if (data.success && data.data)
		return { success: true, sticky_epoch: data.data.sticky_epoch };
	return {
		success: false,
		message: data.message || "Failed to reset sticky bindings",
	};
}

export function useRouteApi() { const request = useAdvancedEditorRequest(); return useMemo(() => ({
fetchRoutesPageData: () => fetchRoutesPageData(request),
saveRoute: (formData: RouteFormData, editingRoute: RouteListRow | null) => saveRoute(formData, editingRoute, request),
deleteRoute: (id: string) => deleteRoute(id, request),
toggleRouteStatus: (id: string, status: "active" | "inactive") => toggleRouteStatus(id, status, request),
patchModelRoutePolicy: (modelId: string, routePolicy: string | null, expectedRoutePolicy: string | null) => patchModelRoutePolicy(modelId, routePolicy, expectedRoutePolicy, request),
patchRoutePoolStrategy: (poolId: string, strategy: string | null) => patchRoutePoolStrategy(poolId, strategy, request),
patchRoutePoolPolicy: (poolId: string, patch: {
		strategy?: string | null;
		tier_strategies?: string | null | Record<string, string>;
		sticky_routing?: { enabled: boolean; idle_ttl_seconds: number };
	}) => patchRoutePoolPolicy(poolId, patch, request),
fetchStickyBindingsSummary: (poolId: string) => fetchStickyBindingsSummary(poolId, request),
lookupStickyBinding: (params: {
	poolId: string;
	modelId: string;
	routeGroup: string;
	protocol: string;
	requestOperation: string;
	userId?: string;
	email?: string;
}) => lookupStickyBinding(params, request),
clearStickyBinding: (poolId: string, affinityHash: string) => clearStickyBinding(poolId, affinityHash, request),
resetStickyBindings: (poolId: string) => resetStickyBindings(poolId, request),
}), [request]); }
