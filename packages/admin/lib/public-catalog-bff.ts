import { parsePricingProfile } from "@octafuse/core";
import { fetchPublicGateway } from "./public-gateway";

type Reader<T> = (value: unknown) => T;
type Fields = Record<string, Reader<unknown>>;
type Projected<T extends Fields> = { [K in keyof T]: ReturnType<T[K]> };
function invalid(): never {
	throw new TypeError("Invalid public catalog response");
}
function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return invalid();
	return value as Record<string, unknown>;
}
function object<T extends Fields>(fields: T): Reader<Projected<T>> {
	return (value) => {
		const source = record(value);
		return Object.fromEntries(
			Object.entries(fields).flatMap(([key, read]) => {
				const field = read(source[key]);
				return field === undefined ? [] : [[key, field]];
			})
		) as Projected<T>;
	};
}
function string(maximum: number, empty = false): Reader<string> {
	return (value) =>
		typeof value === "string" &&
		value.length <= maximum &&
		(empty || value.length > 0)
			? value
			: invalid();
}
const finite: Reader<number> = (value) =>
	typeof value === "number" && Number.isFinite(value) ? value : invalid();
const number: Reader<number> = (value) => {
	const parsed = finite(value);
	return parsed >= 0 ? parsed : invalid();
};
const count: Reader<number> = (value) => {
	const parsed = number(value);
	return Number.isSafeInteger(parsed) ? parsed : invalid();
};
const boolean: Reader<boolean> = (value) =>
	typeof value === "boolean" ? value : invalid();
function literal<T extends string>(...allowed: T[]): Reader<T> {
	return (value) => (allowed.includes(value as T) ? (value as T) : invalid());
}
function nullable<T>(read: Reader<T>): Reader<T | null> {
	return (value) => (value === null ? null : read(value));
}
function optional<T>(read: Reader<T>): Reader<T | undefined> {
	return (value) => (value === undefined ? undefined : read(value));
}
function array<T>(read: Reader<T>, maximum: number): Reader<T[]> {
	return (value) =>
		Array.isArray(value) && value.length <= maximum
			? value.map(read)
			: invalid();
}
function dictionary<T>(
	read: Reader<T>,
	maximum: number
): Reader<Record<string, T>> {
	return (value) => {
		const entries = Object.entries(record(value));
		if (entries.length > maximum) return invalid();
		return Object.fromEntries(
			entries.map(([key, entry]) => {
				if (
					!key ||
					key.length > 256 ||
					["__proto__", "prototype", "constructor"].includes(key)
				)
					return invalid();
				return [key, read(entry)];
			})
		);
	};
}
const instant: Reader<string> = (value) => {
	const parsed = string(64)(value);
	return /^\d{4}-\d{2}-\d{2}T/.test(parsed) &&
		Number.isFinite(Date.parse(parsed))
		? parsed
		: invalid();
};
const slug: Reader<string> = (value) => {
	const parsed = string(256)(value);
	return /^[A-Za-z0-9._:~-]+$/.test(parsed) ? parsed : invalid();
};
const protocols = array(literal("openai", "anthropic", "gemini"), 3);
const strings = array(string(2_000), 2_048);
const priceMap = optional(dictionary(number, 1_024));
const imageSideFields = {
	default: number,
	by_quality: priceMap,
	by_size: priceMap,
	by_quality_size: priceMap,
};
const pricingFields = object({
	tiers: array(
		object({
			upto: nullable(number),
			label: nullable(string(2_000, true)),
			input_price: finite,
			output_price: finite,
			cache_read_price: nullable(finite),
			cache_write_price: nullable(finite),
			image_input_price: nullable(number),
			image_input_cache_price: nullable(number),
			image_output_price: nullable(number),
		}),
		1_024
	),
	image_billing_mode: optional(literal("token", "per_image")),
	image: optional(
		nullable(
			object({
				...imageSideFields,
				input: optional(object(imageSideFields)),
				uncertain_result_policy: optional(literal("requested", "zero")),
			})
		)
	),
	audio_billing_mode: optional(literal("token", "per_second", "per_character")),
	audio: optional(
		nullable((value: unknown) => {
			const source = record(value);
			if ("price_per_second" in source && !("price_per_character" in source))
				return object({
					price_per_second: number,
					minimum_seconds: optional(number),
				})(value);
			if ("price_per_character" in source && !("price_per_second" in source))
				return object({
					price_per_character: number,
					minimum_characters: optional(count),
				})(value);
			return invalid();
		})
	),
});
const pricing: Reader<ReturnType<typeof pricingFields>> = (value) => {
	const projected = pricingFields(value);
	// Reuse the billing domain's tier/mode constraints, without changing its units.
	if (!parsePricingProfile(JSON.stringify(projected))) return invalid();
	return projected;
};
const modelFields = object({
	id: string(2_000),
	slug,
	display_name: nullable(string(2_000, true)),
	vendor: string(80),
	context_window: nullable(count),
	max_tokens: nullable(count),
	pricing_profile: nullable(pricing),
	tags: strings,
	route_groups: strings,
	protocols,
	protocols_by_group: dictionary(protocols, 2_048),
	recommended_protocol: literal("openai", "anthropic", "gemini"),
	description: nullable(string(100_000, true)),
	input_modalities: nullable(strings),
	output_modalities: nullable(strings),
	released_at: nullable(string(128, true)),
	endpoint_slugs: strings,
	regions: strings,
	data_policy_summary: object({
		verified_route_count: count,
		zdr_available: boolean,
		latest_verified_at: nullable(string(128, true)),
	}),
});
const model: Reader<ReturnType<typeof modelFields>> = (value) => {
	const projected = modelFields(value);
	if (
		!projected.protocols.length ||
		!projected.protocols.includes(projected.recommended_protocol)
	)
		return invalid();
	return projected;
};
const provider = object({
	id: string(2_000),
	display_name: string(2_000),
	model_count: count,
	protocols,
	route_groups: strings,
	input_modalities: strings,
	output_modalities: strings,
	latest_released_at: nullable(string(128, true)),
});
const metadata = {
	billing_currency: (value: unknown) => {
		const parsed = string(3)(value);
		return /^[A-Z]{3}$/.test(parsed) ? parsed : invalid();
	},
	generated_at: instant,
};
const models = object({
	object: literal("list"),
	data: array(model, 5_000),
	...metadata,
});
const detail = object({ object: literal("model"), data: model, ...metadata });
const providers = object({
	object: literal("list"),
	data: array(provider, 1_000),
	...metadata,
});
const statsRange = literal("7d", "30d", "90d");
const stats = object({
	object: literal("list"),
	data: array(
		object({
			id: string(2_000),
			slug,
			display_name: string(2_000),
			vendor: string(80),
			request_count: count,
			success_rate: number,
			avg_latency_ms: nullable(number),
			output_tokens: count,
			total_tokens: count,
		}),
		5_000
	),
	range: statsRange,
	window_start: instant,
	window_end: instant,
	minimum_sample_size: count,
	generated_at: instant,
});
function uniqueIds(rows: readonly { id: string }[]): void {
	if (new Set(rows.map((row) => row.id)).size !== rows.length) invalid();
}
function validatedStats(value: unknown, range: string) {
	const projected = stats(value);
	uniqueIds(projected.data);
	if (
		projected.range !== range ||
		projected.minimum_sample_size < 20 ||
		Date.parse(projected.window_start) > Date.parse(projected.window_end) ||
		projected.data.some(
			(row) =>
				row.success_rate > 100 ||
				row.request_count < projected.minimum_sample_size ||
				row.output_tokens > row.total_tokens
		)
	)
		invalid();
	return projected;
}

export type CatalogBffResource =
	| "models"
	| "model"
	| "providers"
	| "stats"
	| "legacy-stats";
type ModelPath = { vendor: string; slug: string };
function pathSegment(value: string, maximum: number, isSlug = false): string {
	if (
		!value ||
		value.length > maximum ||
		value.trim() !== value ||
		value === "." ||
		value === ".." ||
		/[\u0000-\u001f\u007f/\\]/.test(value) ||
		(isSlug && !/^[A-Za-z0-9._:~-]+$/.test(value))
	)
		throw new TypeError("Invalid catalog path");
	return encodeURIComponent(value);
}
function upstreamPath(
	resource: CatalogBffResource,
	request: Request,
	path?: ModelPath
): { path: string; range?: string } {
	const query = new URL(request.url).searchParams;
	const allowed =
		resource === "models"
			? ["route_groups"]
			: resource === "stats" || resource === "legacy-stats"
			? ["range"]
			: [];
	for (const key of query.keys())
		if (!allowed.includes(key) || query.getAll(key).length !== 1)
			throw new TypeError("Invalid catalog query");
	if (resource === "model") {
		if (!path) throw new TypeError("Missing catalog path");
		return {
			path: `/catalog/models/${pathSegment(path.vendor, 80)}/${pathSegment(
				path.slug,
				256,
				true
			)}`,
		};
	}
	if (resource === "models") {
		const raw = query.get("route_groups");
		if (raw !== null) {
			const groups = raw.split(",");
			if (
				groups.length > 32 ||
				groups.some(
					(group) =>
						!group ||
						group.length > 80 ||
						group.trim() !== group ||
						/[\u0000-\u001f\u007f]/.test(group)
				)
			)
				throw new TypeError("Invalid route groups");
			const normalized = new URLSearchParams({
				route_groups: [
					...new Set(groups.map((group) => group.toLowerCase())),
				].join(","),
			});
			return { path: `/catalog/models?${normalized}` };
		}
		return { path: "/catalog/models" };
	}
	if (resource === "providers") return { path: "/catalog/providers" };
	const range = statsRange(query.get("range") ?? "7d");
	return { path: `/catalog/stats/models?range=${range}`, range };
}
function safeRetryAfter(value: string | null): string | null {
	if (!value || value.length > 128) return null;
	return /^\d{1,5}$/.test(value) ||
		(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
			value
		) &&
			Number.isFinite(Date.parse(value)))
		? value
		: null;
}
function failure(
	status: number,
	code: string,
	retryAfter: string | null = null
): Response {
	const headers: Record<string, string> = {
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	};
	if (retryAfter) headers["Retry-After"] = retryAfter;
	return Response.json(
		{
			error: { code, message: "Public catalog request could not be completed" },
		},
		{ status, headers }
	);
}
const MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024;
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Catalog request aborted"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		task.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			}
		);
	});
}
async function readJson(
	response: Response,
	signal: AbortSignal
): Promise<unknown> {
	if (
		!response.headers
			.get("content-type")
			?.split(";")[0]
			?.trim()
			.toLowerCase()
			.endsWith("/json")
	)
		return invalid();
	const declared = response.headers.get("content-length");
	if (
		declared &&
		(!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
	)
		return invalid();
	if (!response.body) return invalid();
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		if (signal.aborted) return invalid();
		while (true) {
			const part = await abortable(reader.read(), signal);
			if (signal.aborted) return invalid();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) return invalid();
			chunks.push(part.value);
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const buffer = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(buffer)
	) as unknown;
}

/** Only these catalog resources may cross the anonymous BFF boundary. */
export function createPublicCatalogBff(
	gateway: typeof fetchPublicGateway = fetchPublicGateway,
	options: { timeoutMs?: number } = {}
) {
	const timeoutMs = options.timeoutMs ?? 8_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_000)
		throw new TypeError("Invalid catalog timeout");
	const handle = async (
		resource: CatalogBffResource,
		request: Request,
		path?: ModelPath
	): Promise<Response> => {
		if (request.method !== "GET" && request.method !== "HEAD")
			return failure(405, "catalog_method_not_allowed");
		let target: ReturnType<typeof upstreamPath>;
		try {
			target = upstreamPath(resource, request, path);
		} catch {
			return failure(400, "invalid_catalog_request");
		}
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), timeoutMs);
		const signal = AbortSignal.any([request.signal, timeout.signal]);
		let upstream: Response | undefined;
		try {
			if (request.signal.aborted)
				return failure(499, "catalog_request_cancelled");
			const pending = gateway(
				target.path,
				{
					method: "GET",
					headers: { accept: "application/json" },
					credentials: "omit",
					redirect: "error",
					cache: "no-store",
					signal,
				},
				{ request }
			);
			upstream = await abortable<Response>(
				pending.then((value) => {
					if (signal.aborted) void value.body?.cancel().catch(() => undefined);
					return value;
				}),
				signal
			);
			if (!upstream.ok) {
				const status =
					upstream.status >= 400 && upstream.status <= 599
						? upstream.status
						: 502;
				return failure(
					status,
					status === 404 ? "catalog_model_not_found" : "catalog_upstream_error",
					safeRetryAfter(upstream.headers.get("retry-after"))
				);
			}
			if (upstream.status !== 200) return failure(502, "catalog_unavailable");
			const body = await readJson(upstream, signal);
			let data: unknown;
			if (resource === "models") {
				const value = models(body);
				uniqueIds(value.data);
				data = value;
			} else if (resource === "providers") {
				const value = providers(body);
				uniqueIds(value.data);
				data = value;
			} else if (resource === "model") {
				const value = detail(body);
				if (
					value.data.slug !== path!.slug ||
					value.data.vendor.toLowerCase() !== path!.vendor.toLowerCase()
				)
					invalid();
				data = value;
			} else {
				const value = validatedStats(body, target.range!);
				data =
					resource === "legacy-stats"
						? {
								status: "ready",
								range: value.range,
								windowStart: value.window_start,
								windowEnd: value.window_end,
								minimumSampleSize: value.minimum_sample_size,
								generatedAt: value.generated_at,
								models: value.data.map((row) => ({
									id: row.id,
									slug: row.slug,
									displayName: row.display_name,
									vendor: row.vendor,
									requestCount: row.request_count,
									successRate: row.success_rate,
									avgLatencyMs: row.avg_latency_ms,
									outputTokens: row.output_tokens,
								})),
						  }
						: value;
			}
			if (request.signal.aborted)
				return failure(499, "catalog_request_cancelled");
			if (timeout.signal.aborted) return failure(504, "catalog_timeout");
			const cache =
				resource === "stats" || resource === "legacy-stats"
					? "public, max-age=60"
					: "public, max-age=60, stale-while-revalidate=300";
			return Response.json(data, {
				headers: {
					"Cache-Control": cache,
					"X-Content-Type-Options": "nosniff",
				},
			});
		} catch {
			if (request.signal.aborted)
				return failure(499, "catalog_request_cancelled");
			if (timeout.signal.aborted) return failure(504, "catalog_timeout");
			return failure(502, "catalog_unavailable");
		} finally {
			clearTimeout(timer);
			void upstream?.body?.cancel().catch(() => undefined);
		}
	};
	return async (
		resource: CatalogBffResource,
		request: Request,
		path?: ModelPath
	): Promise<Response> => {
		const response = await handle(resource, request, path);
		if (request.method !== "HEAD") return response;
		void response.body?.cancel().catch(() => undefined);
		return new Response(null, {
			status: response.status,
			headers: response.headers,
		});
	};
}
export const publicCatalogBff = createPublicCatalogBff();
