import {
	AUDIO_ENDPOINT_PRICING_OPERATIONS,
	normalizeAudioEndpointCapabilities,
	type AudioEndpointCapabilities,
	type AudioEndpointPricingMeter,
	type AudioEndpointPricingOperation,
} from "@octafuse/core/model-endpoint-catalog";
import type {
	EndpointFormState,
	EndpointListItem,
	EndpointModelOption,
	EndpointProviderOption,
	EndpointRouteOption,
	DeepSeekEndpointBootstrapResult,
	TriState,
} from "./types";

export type AudioCapabilitySummary = {
	operation: AudioEndpointPricingOperation;
	meterKind: AudioEndpointPricingMeter["kind"];
	unit: AudioEndpointPricingMeter["unit"];
};

export type AudioCapabilitiesPreview =
	| {
			ok: true;
			capabilities: AudioEndpointCapabilities | null;
			summary: AudioCapabilitySummary[];
	  }
	| { ok: false; message: string };

type ApiEnvelope<T> = { success?: boolean; data?: T; message?: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		cache: "no-store",
		...init,
		headers: {
			...(init?.body ? { "Content-Type": "application/json" } : {}),
			...init?.headers,
		},
	});
	let payload: ApiEnvelope<T>;
	try {
		payload = (await response.json()) as ApiEnvelope<T>;
	} catch {
		throw new Error(`Request failed (${response.status})`);
	}
	if (!response.ok || payload.success === false) {
		throw new Error(payload.message || `Request failed (${response.status})`);
	}
	if (payload.data === undefined) return undefined as T;
	return payload.data;
}

export async function loadEndpointWorkspace(): Promise<{
	endpoints: EndpointListItem[];
	models: EndpointModelOption[];
	providers: EndpointProviderOption[];
	routes: EndpointRouteOption[];
}> {
	const [endpoints, models, providers, routes] = await Promise.all([
		api<EndpointListItem[]>("/api/admin/endpoints"),
		api<EndpointModelOption[]>("/api/admin/models"),
		api<EndpointProviderOption[]>("/api/admin/providers"),
		api<EndpointRouteOption[]>("/api/admin/routes"),
	]);
	return { endpoints, models, providers, routes };
}

function triState(value: TriState): boolean | null {
	if (value === "true") return true;
	if (value === "false") return false;
	return null;
}

function nullableInteger(value: string): number | null {
	const normalized = value.trim();
	return normalized ? Number(normalized) : null;
}

const EXTRA_PRICING_KEYS = new Set([
	"audio",
	"audio_output",
	"discount",
	"image_token",
	"input_audio_cache",
	"input_cache_write_1h",
	"internal_reasoning",
	"web_search",
]);

function pricingExtrasFromForm(
	form: EndpointFormState
): Record<string, unknown> {
	const raw = form.pricing_extras_json.trim();
	if (!raw) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new TypeError("Additional pricing must be a JSON object");
	}
	for (const key of Object.keys(parsed)) {
		if (!EXTRA_PRICING_KEYS.has(key)) {
			throw new TypeError(`Unsupported additional pricing field: ${key}`);
		}
	}
	return parsed as Record<string, unknown>;
}

function pricingFromForm(
	form: EndpointFormState
): Record<string, unknown> | null {
	const extras = pricingExtrasFromForm(form);
	if (
		!form.prompt_price.trim() &&
		!form.completion_price.trim() &&
		Object.keys(extras).length === 0
	) {
		return null;
	}
	const pricing: Record<string, unknown> = {
		...extras,
		currency: "USD",
		prompt: form.prompt_price.trim(),
		completion: form.completion_price.trim(),
	};
	for (const [key, value] of [
		["request", form.request_price],
		["image", form.image_price],
		["image_output", form.image_output_price],
		["input_cache_read", form.input_cache_read_price],
		["input_cache_write", form.input_cache_write_price],
	] as const) {
		if (value.trim()) pricing[key] = value.trim();
	}
	return pricing;
}

function imageCapabilitiesFromForm(form: EndpointFormState): unknown {
	const raw = form.image_capabilities_json.trim();
	return raw ? (JSON.parse(raw) as unknown) : null;
}

export function summarizeAudioCapabilities(
	capabilities: AudioEndpointCapabilities | null
): AudioCapabilitySummary[] {
	if (!capabilities) return [];
	const result: AudioCapabilitySummary[] = [];
	for (const operation of AUDIO_ENDPOINT_PRICING_OPERATIONS) {
		const pricing = capabilities.pricing_by_operation[operation];
		if (!pricing) continue;
		result.push({
			operation,
			meterKind: pricing.meter.kind,
			unit: pricing.meter.unit,
		});
	}
	return result;
}

export function previewAudioCapabilitiesJson(
	rawInput: string
): AudioCapabilitiesPreview {
	const raw = rawInput.trim();
	if (!raw) return { ok: true, capabilities: null, summary: [] };
	try {
		const capabilities = normalizeAudioEndpointCapabilities(
			JSON.parse(raw) as unknown
		);
		return {
			ok: true,
			capabilities,
			summary: summarizeAudioCapabilities(capabilities),
		};
	} catch (error) {
		return {
			ok: false,
			message:
				error instanceof Error
					? error.message
					: "Invalid audio capabilities JSON",
		};
	}
}

function audioCapabilitiesFromForm(
	form: EndpointFormState
): AudioEndpointCapabilities | null {
	const preview = previewAudioCapabilitiesJson(form.audio_capabilities_json);
	if (!preview.ok) throw new TypeError(preview.message);
	return preview.capabilities;
}

export function endpointMutationFromForm(form: EndpointFormState) {
	return {
		model_id: form.model_id,
		provider_id: form.provider_id,
		provider_slug: form.provider_slug,
		tag: form.tag,
		endpoint_class: form.endpoint_class || null,
		region: form.region || null,
		context_length: nullableInteger(form.context_length),
		max_prompt_tokens: nullableInteger(form.max_prompt_tokens),
		max_completion_tokens: nullableInteger(form.max_completion_tokens),
		quantization: form.quantization || null,
		supported_parameters: form.supported_parameters
			.split(/[\s,]+/u)
			.map((value) => value.trim())
			.filter(Boolean),
		pricing: pricingFromForm(form),
		supports_implicit_caching: triState(form.implicit_caching),
		supports_voice_cloning: triState(form.voice_cloning),
		supports_tool_choice: {
			auto: triState(form.tool_choice_auto),
			function: triState(form.tool_choice_function),
			none: triState(form.tool_choice_none),
			required: triState(form.tool_choice_required),
		},
		image_capabilities: imageCapabilitiesFromForm(form),
		audio_capabilities: audioCapabilitiesFromForm(form),
		evidence_url: form.evidence_url || null,
		expires_at: form.expires_at
			? new Date(form.expires_at).toISOString()
			: null,
		status: form.status,
	};
}

export async function saveEndpoint(
	form: EndpointFormState,
	id?: string
): Promise<void> {
	const body = JSON.stringify(endpointMutationFromForm(form));
	if (id) {
		await api<void>(`/api/admin/endpoints/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body,
		});
		return;
	}
	await api<{ id: string }>("/api/admin/endpoints", { method: "POST", body });
}

export async function deleteEndpoint(id: string): Promise<void> {
	await api<void>(`/api/admin/endpoints/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

export async function setEndpointRouteLink(
	endpointId: string,
	routeTargetId: string,
	linked: boolean
): Promise<void> {
	await api<void>(
		`/api/admin/endpoints/${encodeURIComponent(
			endpointId
		)}/routes/${encodeURIComponent(routeTargetId)}`,
		{ method: linked ? "POST" : "DELETE" }
	);
}

export async function publishOfficialDeepSeekEndpoints(): Promise<DeepSeekEndpointBootstrapResult> {
	return api<DeepSeekEndpointBootstrapResult>(
		"/api/admin/endpoints/bootstrap/deepseek",
		{
			method: "POST",
			body: JSON.stringify({ publish: true }),
		}
	);
}

function booleanToTriState(value: boolean | null): TriState {
	return value == null ? "unknown" : value ? "true" : "false";
}

function padDateTimePart(value: number): string {
	return String(value).padStart(2, "0");
}

export function isoToLocalDateTimeInput(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return "";
	return `${date.getFullYear()}-${padDateTimePart(
		date.getMonth() + 1
	)}-${padDateTimePart(date.getDate())}T${padDateTimePart(
		date.getHours()
	)}:${padDateTimePart(date.getMinutes())}`;
}

function additionalPricingJson(pricing: EndpointListItem["pricing"]): string {
	if (!pricing) return "";
	const extras = Object.fromEntries(
		Object.entries(pricing).filter(([key]) => EXTRA_PRICING_KEYS.has(key))
	);
	return Object.keys(extras).length > 0 ? JSON.stringify(extras, null, 2) : "";
}

export function endpointToForm(endpoint: EndpointListItem): EndpointFormState {
	const pricing = endpoint.pricing;
	return {
		model_id: endpoint.model_id,
		provider_id: endpoint.provider_id,
		provider_slug: endpoint.provider_slug,
		tag: endpoint.tag,
		endpoint_class:
			endpoint.endpoint_class === "service_tier" ? "service_tier" : "standard",
		region: endpoint.region ?? "",
		context_length: endpoint.context_length?.toString() ?? "",
		max_prompt_tokens: endpoint.max_prompt_tokens?.toString() ?? "",
		max_completion_tokens: endpoint.max_completion_tokens?.toString() ?? "",
		quantization: endpoint.quantization ?? "",
		supported_parameters: endpoint.supported_parameters.join(", "),
		prompt_price: pricing?.prompt ?? "",
		completion_price: pricing?.completion ?? "",
		request_price: pricing?.request ?? "",
		image_price: pricing?.image ?? "",
		image_output_price: pricing?.image_output ?? "",
		input_cache_read_price: pricing?.input_cache_read ?? "",
		input_cache_write_price: pricing?.input_cache_write ?? "",
		pricing_extras_json: additionalPricingJson(pricing),
		implicit_caching: booleanToTriState(endpoint.supports_implicit_caching),
		voice_cloning: booleanToTriState(endpoint.supports_voice_cloning),
		tool_choice_auto: booleanToTriState(endpoint.supports_tool_choice.auto),
		tool_choice_function: booleanToTriState(
			endpoint.supports_tool_choice.function
		),
		tool_choice_none: booleanToTriState(endpoint.supports_tool_choice.none),
		tool_choice_required: booleanToTriState(
			endpoint.supports_tool_choice.required
		),
		image_capabilities_json: endpoint.image_capabilities
			? JSON.stringify(endpoint.image_capabilities, null, 2)
			: "",
		audio_capabilities_json: endpoint.audio_capabilities
			? JSON.stringify(endpoint.audio_capabilities, null, 2)
			: "",
		evidence_url: endpoint.evidence_url ?? "",
		expires_at: endpoint.expires_at
			? isoToLocalDateTimeInput(endpoint.expires_at)
			: "",
		status: endpoint.status,
	};
}
