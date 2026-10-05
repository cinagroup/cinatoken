/** Public debug metadata must never contain an upstream credential or upload bytes. */
const PRIVATE_FIELD =
	/(?:api[-_]?key|authorization|(?:access|refresh|auth|id)[-_]?token|^token$|secret|password|credential|signature|private[-_]?key|cookie)/iu;
export const PLAYGROUND_WIRE_HEADER_MAX_BYTES = 6144;

// Unknown route defaults are represented by name only. A custom field can hold
// an arbitrary credential without using a recognizable credential prefix.
const DISPLAY_PARAMETER_FIELDS = new Set(
	(
		"model messages role content contents parts text type input prompt system tools tool_choice " +
		"function name description parameters properties required additionalProperties enum items format response_format json_schema schema " +
		"max_tokens max_output_tokens max_completion_tokens temperature top_p top_k n size quality background stream stream_options include_usage " +
		"stop seed presence_penalty frequency_penalty reasoning reasoning_effort effort budget_tokens thinking enabled generationConfig " +
		"maxOutputTokens topP topK safetySettings category threshold output modalities audio voice speed language instructions encoding_type " +
		"sample_rate volume rate pitch payload header action event task_id task task_group resources duplex session session_id format mode input_type file_url file_urls url image_url image images file filename file_name return_documents " +
		"top_n documents query score normalize result_format incremental_output enable_search enable_thinking"
	).split(/\s+/u)
);

export function safePlaygroundCustomParams(
	value: unknown
): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const project = (entry: unknown, depth: number): unknown => {
		if (depth > 24) return "[preview depth limit]";
		if (Array.isArray(entry))
			return entry.map((item) => project(item, depth + 1));
		if (entry && typeof entry === "object")
			return Object.fromEntries(
				Object.entries(entry)
					.filter(
						([key]) => !["__proto__", "constructor", "prototype"].includes(key)
					)
					.map(([key, item]) => [
						key,
						PRIVATE_FIELD.test(key) || !DISPLAY_PARAMETER_FIELDS.has(key)
							? "[redacted route parameter]"
							: project(item, depth + 1),
					])
			);
		return safePlaygroundValue(entry);
	};
	return project(value, 0) as Record<string, unknown>;
}

export function playgroundPrivateDefaultValues(value: unknown): string[] {
	const secrets: string[] = [];
	const collect = (item: unknown): void => {
		if (typeof item === "string" && item.length) secrets.push(item);
		else if (Array.isArray(item)) item.forEach(collect);
		else if (item && typeof item === "object")
			Object.values(item).forEach(collect);
	};
	const visit = (item: unknown): void => {
		if (Array.isArray(item)) item.forEach(visit);
		else if (item && typeof item === "object")
			for (const [key, child] of Object.entries(item)) {
				if (PRIVATE_FIELD.test(key) || !DISPLAY_PARAMETER_FIELDS.has(key))
					collect(child);
				else visit(child);
			}
	};
	visit(value);
	return secrets;
}

/** Apply the same projection to execution metadata without changing the wire. */
export function safePlaygroundWireDefaults(
	raw: string,
	defaults: Record<string, unknown> | null
): string {
	let wire: unknown;
	try {
		wire = JSON.parse(raw) as unknown;
	} catch {
		return raw;
	}
	const visit = (value: unknown, configured: unknown): unknown => {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			!configured ||
			typeof configured !== "object" ||
			Array.isArray(configured)
		)
			return value;
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				Object.hasOwn(configured, key) && !DISPLAY_PARAMETER_FIELDS.has(key)
					? "[redacted route parameter]"
					: visit(item, (configured as Record<string, unknown>)[key]),
			])
		);
	};
	return JSON.stringify(visit(wire, defaults));
}

export function safePlaygroundText(
	value: string,
	secrets: readonly string[] = []
): string {
	let safe = value;
	for (const secret of secrets)
		if (secret) safe = safe.split(secret).join("[redacted]");
	return safe
		.replace(/(?:sk-|tvly-|fc-|jina_|AKID)[A-Za-z0-9_-]{4,}/gu, "[redacted]")
		.replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

export function safePlaygroundUrl(
	raw: string,
	secrets: readonly string[] = []
): string {
	try {
		const url = new URL(raw);
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			// Only these values are protocol metadata, all provider-specific query values are private.
			const value = url.searchParams.get(key) ?? "";
			if (key === "alt" && (value === "sse" || value === "json")) continue;
			url.searchParams.set(key, "(redacted)");
		}
		const safe = safePlaygroundText(url.toString(), secrets);
		return safe.length > 4096 ? safe.slice(0, 4096) + "[truncated]" : safe;
	} catch {
		return "[unavailable upstream URL]";
	}
}

export function safePlaygroundValue(
	value: unknown,
	secrets: readonly string[] = [],
	depth = 0
): unknown {
	if (depth > 24) return "[preview depth limit]";
	if (typeof value === "string") {
		if (/^data:[^,]+,/iu.test(value))
			return `[upload ${value.length} characters]`;
		if (/^(?:https?|wss?):\/\//iu.test(value))
			return safePlaygroundUrl(value, secrets);
		return safePlaygroundText(value, secrets);
	}
	if (Array.isArray(value))
		return value.map((item) => safePlaygroundValue(item, secrets, depth + 1));
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (key === "__proto__" || key === "constructor" || key === "prototype")
				continue;
			result[key] = PRIVATE_FIELD.test(key)
				? "[redacted]"
				: safePlaygroundValue(item, secrets, depth + 1);
		}
		return result;
	}
	return value;
}

/** Bound the encoded header size, including non-ASCII JSON and URI expansion. */
export function safePlaygroundWireJson(
	raw: string,
	secrets: readonly string[] = []
): string {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		value = { preview: raw };
	}
	const safe = JSON.stringify(safePlaygroundValue(value, secrets), null, 2);
	if (encodeURIComponent(safe).length <= PLAYGROUND_WIRE_HEADER_MAX_BYTES)
		return safe;
	const points = [...safe];
	let count = Math.min(points.length, 4000);
	while (count >= 0) {
		const truncated = JSON.stringify({
			__playground_truncated: true,
			__original_length: safe.length,
			__preview: points.slice(0, count).join(""),
		});
		if (
			encodeURIComponent(truncated).length <= PLAYGROUND_WIRE_HEADER_MAX_BYTES
		)
			return truncated;
		count = Math.floor(count * 0.75);
	}
	return '{"__playground_truncated":true}';
}
