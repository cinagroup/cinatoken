const MAX_DECIMAL_INTEGER_DIGITS = 20;
const MAX_DECIMAL_FRACTION_DIGITS = 18;
const MAX_STRING_LENGTH = 128;
const MAX_COLLECTION_SIZE = 256;
const MAX_IMAGE_COST_USD = 1_000_000_000;
const MAX_AUDIO_METER_UNITS = 1_000_000_000;

export type EvidenceBoolean = boolean | null;

export type EndpointToolChoiceSupport = {
	auto: EvidenceBoolean;
	function: EvidenceBoolean;
	none: EvidenceBoolean;
	required: EvidenceBoolean;
};

export type EndpointCapabilities = {
	implicit_caching: EvidenceBoolean;
	tool_choice: EndpointToolChoiceSupport;
	voice_cloning: EvidenceBoolean;
};

export type TextEndpointPricing = {
	currency: "USD";
	prompt: string;
	completion: string;
	audio?: string;
	audio_output?: string;
	discount?: number;
	image?: string;
	image_output?: string;
	image_token?: string;
	input_audio_cache?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	input_cache_write_1h?: string;
	internal_reasoning?: string;
	request?: string;
	web_search?: string;
};

/**
 * Audio operations whose cost can currently be represented by an exact,
 * endpoint-scoped pricing contract. Realtime TTS session creation is omitted
 * deliberately: the session itself is not a billable inference operation.
 */
export const AUDIO_ENDPOINT_PRICING_OPERATIONS = [
	"audio.transcriptions",
	"audio.transcriptions.multimodal",
	"audio.transcriptions.async",
	"audio.transcriptions.realtime.inference",
	"audio.transcriptions.realtime.session",
	"audio.speech",
	"audio.speech.stream",
	"audio.speech.multimodal",
	"audio.speech.realtime.inference",
] as const;

export type AudioEndpointPricingOperation =
	(typeof AUDIO_ENDPOINT_PRICING_OPERATIONS)[number];

export type AudioDurationPricingMeter = {
	kind: "duration";
	unit: "second";
	price: string;
	minimum_units: number;
	increment_units: number;
};

export type AudioCharacterPricingMeter = {
	kind: "characters";
	unit: "unicode_code_point";
	price: string;
	minimum_units: number;
	increment_units: number;
};

export type AudioTokenPricingRates = {
	input_audio: string;
	input_text: string;
	output_text: string;
	output_audio: string;
	input_audio_cache: string;
};

export type AudioTokenPricingMeter = {
	kind: "tokens";
	unit: "token";
	rates: AudioTokenPricingRates;
	/** Token pricing is safe only with the provider's authoritative breakdown. */
	require_authoritative_breakdown: true;
};

export type AudioEndpointPricingMeter =
	| AudioDurationPricingMeter
	| AudioCharacterPricingMeter
	| AudioTokenPricingMeter;

export type AudioOperationPricing = {
	currency: "USD";
	meter: AudioEndpointPricingMeter;
	request?: string;
	discount?: number;
};

export type AudioEndpointCapabilities = {
	v: 1;
	pricing_by_operation: Partial<
		Record<AudioEndpointPricingOperation, AudioOperationPricing>
	>;
};

export type ImageCapabilityDescriptor =
	| { type: "boolean" }
	| { type: "enum"; values: string[] }
	| { type: "range"; min: number; max: number };

export type ImagePricingBillable =
	| "output_image"
	| "input_image"
	| "input_font"
	| "input_reference"
	| "input_text";
export type ImagePricingUnit = "request" | "image" | "megapixel" | "token";

export type ImageEndpointPricingLine = {
	billable: ImagePricingBillable;
	unit: ImagePricingUnit;
	cost_usd: string;
	variant?: string;
};

export type ImageEndpointCapabilities = {
	provider_slug: string;
	provider_tag: string | null;
	supports_streaming: EvidenceBoolean;
	supported_parameters: Record<string, ImageCapabilityDescriptor>;
	allowed_passthrough_parameters: string[];
	pricing: ImageEndpointPricingLine[];
};

export type SerializedImageEndpointPricingLine = Omit<
	ImageEndpointPricingLine,
	"cost_usd"
> & {
	cost_usd: number;
};

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function allowKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string
): void {
	const set = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!set.has(key))
			throw new TypeError(`${label} contains unsupported key: ${key}`);
	}
}

function boundedString(
	value: unknown,
	label: string,
	pattern?: RegExp
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_STRING_LENGTH
	) {
		throw new TypeError(
			`${label} must be a non-empty string of at most ${MAX_STRING_LENGTH} characters`
		);
	}
	if (pattern && !pattern.test(value))
		throw new TypeError(`${label} has an invalid format`);
	return value;
}

/** Converts a non-negative fixed decimal into its canonical, non-exponent form. */
export function normalizeUsdDecimal(
	value: unknown,
	label = "USD amount"
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 64 ||
		!/^\d+(?:\.\d+)?$/.test(value)
	) {
		throw new TypeError(`${label} must be a non-negative fixed decimal string`);
	}
	const [rawInteger, rawFraction = ""] = value.split(".");
	const integer = rawInteger!.replace(/^0+(?=\d)/, "");
	if (
		integer.length > MAX_DECIMAL_INTEGER_DIGITS ||
		rawFraction.length > MAX_DECIMAL_FRACTION_DIGITS
	) {
		throw new TypeError(`${label} exceeds supported decimal precision`);
	}
	const fraction = rawFraction.replace(/0+$/, "");
	return fraction.length > 0 ? `${integer}.${fraction}` : integer;
}

const PRICE_KEYS = [
	"audio",
	"audio_output",
	"completion",
	"discount",
	"image",
	"image_output",
	"image_token",
	"input_audio_cache",
	"input_cache_read",
	"input_cache_write",
	"input_cache_write_1h",
	"internal_reasoning",
	"prompt",
	"request",
	"web_search",
	"currency",
] as const;
const OPTIONAL_DECIMAL_PRICE_KEYS = PRICE_KEYS.filter(
	(key) => !["currency", "prompt", "completion", "discount"].includes(key)
);

export function normalizeTextEndpointPricing(
	input: unknown
): TextEndpointPricing {
	const value = record(input, "text endpoint pricing");
	allowKeys(value, PRICE_KEYS, "text endpoint pricing");
	if (value.currency !== "USD")
		throw new TypeError("text endpoint pricing currency must be USD");
	const output: TextEndpointPricing = {
		currency: "USD",
		prompt: normalizeUsdDecimal(value.prompt, "prompt price"),
		completion: normalizeUsdDecimal(value.completion, "completion price"),
	};
	for (const key of OPTIONAL_DECIMAL_PRICE_KEYS) {
		if (value[key] !== undefined) {
			(output as unknown as Record<string, unknown>)[key] = normalizeUsdDecimal(
				value[key],
				`${key} price`
			);
		}
	}
	if (value.discount !== undefined) {
		if (
			typeof value.discount !== "number" ||
			!Number.isFinite(value.discount) ||
			value.discount < 0 ||
			value.discount > 1
		) {
			throw new TypeError("discount must be a finite number between 0 and 1");
		}
		output.discount = value.discount;
	}
	return output;
}

const AUDIO_OPERATION_METER_KINDS = {
	"audio.transcriptions": ["duration", "tokens"],
	"audio.transcriptions.multimodal": ["duration"],
	"audio.transcriptions.async": ["duration"],
	"audio.transcriptions.realtime.inference": ["duration"],
	"audio.transcriptions.realtime.session": ["duration"],
	"audio.speech": ["characters"],
	"audio.speech.stream": ["characters"],
	"audio.speech.multimodal": ["characters"],
	"audio.speech.realtime.inference": ["characters"],
} as const satisfies Record<
	AudioEndpointPricingOperation,
	readonly AudioEndpointPricingMeter["kind"][]
>;

function boundedDurationUnits(
	value: unknown,
	label: string,
	allowZero: boolean
): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		(allowZero ? value < 0 : value <= 0) ||
		value > MAX_AUDIO_METER_UNITS
	) {
		throw new TypeError(
			`${label} must be a finite number ${
				allowZero ? "greater than or equal to 0" : "greater than 0"
			} and at most ${MAX_AUDIO_METER_UNITS}`
		);
	}
	return value;
}

function boundedCharacterUnits(
	value: unknown,
	label: string,
	minimum: number
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > MAX_AUDIO_METER_UNITS
	) {
		throw new TypeError(
			`${label} must be a safe integer greater than or equal to ${minimum} and at most ${MAX_AUDIO_METER_UNITS}`
		);
	}
	return value;
}

function normalizeAudioTokenRates(input: unknown): AudioTokenPricingRates {
	const value = record(input, "audio token rates");
	const keys = [
		"input_audio",
		"input_text",
		"output_text",
		"output_audio",
		"input_audio_cache",
	] as const;
	allowKeys(value, keys, "audio token rates");
	return {
		input_audio: normalizeUsdDecimal(
			value.input_audio,
			"audio token input_audio rate"
		),
		input_text: normalizeUsdDecimal(
			value.input_text,
			"audio token input_text rate"
		),
		output_text: normalizeUsdDecimal(
			value.output_text,
			"audio token output_text rate"
		),
		output_audio: normalizeUsdDecimal(
			value.output_audio,
			"audio token output_audio rate"
		),
		input_audio_cache: normalizeUsdDecimal(
			value.input_audio_cache,
			"audio token input_audio_cache rate"
		),
	};
}

function normalizeAudioPricingMeter(
	input: unknown,
	operation: AudioEndpointPricingOperation
): AudioEndpointPricingMeter {
	const label = `audio pricing ${operation}.meter`;
	const value = record(input, label);
	const kind = value.kind as AudioEndpointPricingMeter["kind"] | undefined;
	if (!(AUDIO_OPERATION_METER_KINDS[operation] as readonly unknown[]).includes(kind)) {
		throw new TypeError(`${label}.kind is unsupported for ${operation}`);
	}
	if (kind === "duration" || kind === "characters") {
		allowKeys(
			value,
			["kind", "unit", "price", "minimum_units", "increment_units"],
			label
		);
		const expectedUnit =
			kind === "duration" ? "second" : "unicode_code_point";
		if (value.unit !== expectedUnit) {
			throw new TypeError(`${label}.unit must be ${expectedUnit}`);
		}
		const price = normalizeUsdDecimal(value.price, `${label}.price`);
		return kind === "duration"
			? {
					kind,
					unit: "second",
					price,
					minimum_units: boundedDurationUnits(
						value.minimum_units,
						`${label}.minimum_units`,
						true
					),
					increment_units: boundedDurationUnits(
						value.increment_units,
						`${label}.increment_units`,
						false
					),
				}
			: {
					kind,
					unit: "unicode_code_point",
					price,
					minimum_units: boundedCharacterUnits(
						value.minimum_units,
						`${label}.minimum_units`,
						0
					),
					increment_units: boundedCharacterUnits(
						value.increment_units,
						`${label}.increment_units`,
						1
					),
				};
	}

	allowKeys(
		value,
		["kind", "unit", "rates", "require_authoritative_breakdown"],
		label
	);
	if (value.unit !== "token") throw new TypeError(`${label}.unit must be token`);
	if (value.require_authoritative_breakdown !== true) {
		throw new TypeError(
			`${label}.require_authoritative_breakdown must be true`
		);
	}
	return {
		kind: "tokens",
		unit: "token",
		rates: normalizeAudioTokenRates(value.rates),
		require_authoritative_breakdown: true,
	};
}

function normalizeAudioOperationPricing(
	input: unknown,
	operation: AudioEndpointPricingOperation
): AudioOperationPricing {
	const label = `audio pricing ${operation}`;
	const value = record(input, label);
	allowKeys(value, ["currency", "meter", "request", "discount"], label);
	if (value.currency !== "USD") {
		throw new TypeError(`${label}.currency must be USD`);
	}
	const output: AudioOperationPricing = {
		currency: "USD",
		meter: normalizeAudioPricingMeter(value.meter, operation),
	};
	if (value.request !== undefined) {
		output.request = normalizeUsdDecimal(value.request, `${label}.request`);
	}
	if (value.discount !== undefined) {
		if (
			typeof value.discount !== "number" ||
			!Number.isFinite(value.discount) ||
			value.discount < 0 ||
			value.discount > 1
		) {
			throw new TypeError(`${label}.discount must be between 0 and 1`);
		}
		output.discount = value.discount;
	}
	return output;
}

/**
 * Parse endpoint-scoped audio evidence. Unknown operations, meter/operation
 * mismatches, implicit units, exponent prices, and incomplete token dimensions
 * are rejected instead of being guessed from legacy model pricing.
 */
export function normalizeAudioEndpointCapabilities(
	input: unknown
): AudioEndpointCapabilities {
	const value = record(input, "audio endpoint capabilities");
	allowKeys(value, ["v", "pricing_by_operation"], "audio endpoint capabilities");
	if (value.v !== 1) {
		throw new TypeError("audio endpoint capabilities v must be 1");
	}
	const pricingInput = record(
		value.pricing_by_operation,
		"audio endpoint pricing_by_operation"
	);
	const operations = Object.keys(pricingInput);
	if (
		operations.length === 0 ||
		operations.length > AUDIO_ENDPOINT_PRICING_OPERATIONS.length
	) {
		throw new TypeError(
			"audio endpoint pricing_by_operation must contain at least one supported operation"
		);
	}
	allowKeys(
		pricingInput,
		AUDIO_ENDPOINT_PRICING_OPERATIONS,
		"audio endpoint pricing_by_operation"
	);
	const pricingByOperation: AudioEndpointCapabilities["pricing_by_operation"] = {};
	for (const operation of AUDIO_ENDPOINT_PRICING_OPERATIONS) {
		const operationPricing = pricingInput[operation];
		if (operationPricing !== undefined) {
			pricingByOperation[operation] = normalizeAudioOperationPricing(
				operationPricing,
				operation
			);
		}
	}
	return { v: 1, pricing_by_operation: pricingByOperation };
}

export function isAudioEndpointReady(
	value: AudioEndpointCapabilities
): boolean {
	return Object.keys(value.pricing_by_operation).length > 0;
}

export function audioEndpointSupportsOperation(
	value: AudioEndpointCapabilities,
	operation: string
): operation is AudioEndpointPricingOperation {
	return Object.prototype.hasOwnProperty.call(
		value.pricing_by_operation,
		operation
	);
}

function evidenceBoolean(value: unknown, label: string): EvidenceBoolean {
	if (value !== null && typeof value !== "boolean")
		throw new TypeError(`${label} must be true, false, or null`);
	return value as EvidenceBoolean;
}

export function normalizeEndpointCapabilities(
	input: unknown
): EndpointCapabilities {
	const value = record(input, "endpoint capabilities");
	allowKeys(
		value,
		["implicit_caching", "tool_choice", "voice_cloning"],
		"endpoint capabilities"
	);
	const toolChoice = record(value.tool_choice, "tool_choice");
	allowKeys(
		toolChoice,
		["auto", "function", "none", "required"],
		"tool_choice"
	);
	return {
		implicit_caching: evidenceBoolean(
			value.implicit_caching,
			"implicit_caching"
		),
		tool_choice: {
			auto: evidenceBoolean(toolChoice.auto, "tool_choice.auto"),
			function: evidenceBoolean(toolChoice.function, "tool_choice.function"),
			none: evidenceBoolean(toolChoice.none, "tool_choice.none"),
			required: evidenceBoolean(toolChoice.required, "tool_choice.required"),
		},
		voice_cloning: evidenceBoolean(value.voice_cloning, "voice_cloning"),
	};
}

export function isPublicEndpointCapabilityReady(
	value: EndpointCapabilities
): boolean {
	return (
		value.implicit_caching !== null &&
		value.voice_cloning !== null &&
		Object.values(value.tool_choice).every((item) => item !== null)
	);
}

function uniqueStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_COLLECTION_SIZE)
		throw new TypeError(
			`${label} must be an array of at most ${MAX_COLLECTION_SIZE} strings`
		);
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const normalized = boundedString(
			item,
			`${label} item`,
			/^[a-zA-Z0-9_.:-]+$/
		);
		if (seen.has(normalized))
			throw new TypeError(`${label} contains a duplicate: ${normalized}`);
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function capabilityDescriptor(
	input: unknown,
	label: string
): ImageCapabilityDescriptor {
	const value = record(input, label);
	if (value.type === "boolean") {
		allowKeys(value, ["type"], label);
		return { type: "boolean" };
	}
	if (value.type === "enum") {
		allowKeys(value, ["type", "values"], label);
		const values = uniqueStringArray(value.values, `${label}.values`);
		if (values.length === 0)
			throw new TypeError(`${label}.values must not be empty`);
		return { type: "enum", values };
	}
	if (value.type === "range") {
		allowKeys(value, ["type", "min", "max"], label);
		if (
			typeof value.min !== "number" ||
			typeof value.max !== "number" ||
			!Number.isFinite(value.min) ||
			!Number.isFinite(value.max) ||
			value.min > value.max
		) {
			throw new TypeError(`${label} must have a finite range with min <= max`);
		}
		return { type: "range", min: value.min, max: value.max };
	}
	throw new TypeError(`${label}.type must be boolean, enum, or range`);
}

const BILLABLES = new Set<ImagePricingBillable>([
	"output_image",
	"input_image",
	"input_font",
	"input_reference",
	"input_text",
]);
const UNITS = new Set<ImagePricingUnit>([
	"request",
	"image",
	"megapixel",
	"token",
]);

export function normalizeImageEndpointCapabilities(
	input: unknown
): ImageEndpointCapabilities {
	const value = record(input, "image endpoint capabilities");
	allowKeys(
		value,
		[
			"provider_slug",
			"provider_tag",
			"supports_streaming",
			"supported_parameters",
			"allowed_passthrough_parameters",
			"pricing",
		],
		"image endpoint capabilities"
	);
	const providerSlug = boundedString(
		value.provider_slug,
		"provider_slug",
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/
	);
	const providerTag =
		value.provider_tag === null
			? null
			: boundedString(
					value.provider_tag,
					"provider_tag",
					/^[a-zA-Z0-9_.:/-]+$/
			  );
	const parameters = record(value.supported_parameters, "supported_parameters");
	if (Object.keys(parameters).length > MAX_COLLECTION_SIZE)
		throw new TypeError(
			`supported_parameters must have at most ${MAX_COLLECTION_SIZE} entries`
		);
	const supportedParameters: Record<string, ImageCapabilityDescriptor> = {};
	for (const [key, descriptor] of Object.entries(parameters)) {
		boundedString(key, "supported parameter name", /^[a-zA-Z0-9_.:-]+$/);
		supportedParameters[key] = capabilityDescriptor(
			descriptor,
			`supported_parameters.${key}`
		);
	}
	if (
		!Array.isArray(value.pricing) ||
		value.pricing.length > MAX_COLLECTION_SIZE
	)
		throw new TypeError(
			`pricing must be an array of at most ${MAX_COLLECTION_SIZE} lines`
		);
	const pricing: ImageEndpointPricingLine[] = [];
	const seenPricing = new Set<string>();
	for (const [index, inputLine] of value.pricing.entries()) {
		const line = record(inputLine, `pricing[${index}]`);
		allowKeys(
			line,
			["billable", "unit", "cost_usd", "variant"],
			`pricing[${index}]`
		);
		if (!BILLABLES.has(line.billable as ImagePricingBillable))
			throw new TypeError(`pricing[${index}].billable is unsupported`);
		if (!UNITS.has(line.unit as ImagePricingUnit))
			throw new TypeError(`pricing[${index}].unit is unsupported`);
		const variant =
			line.variant === undefined
				? undefined
				: boundedString(line.variant, `pricing[${index}].variant`);
		const identity = `${line.billable}\u0000${line.unit}\u0000${variant ?? ""}`;
		if (seenPricing.has(identity))
			throw new TypeError(
				`pricing contains a duplicate billable/unit/variant line`
			);
		seenPricing.add(identity);
		pricing.push({
			billable: line.billable as ImagePricingBillable,
			unit: line.unit as ImagePricingUnit,
			cost_usd: normalizeUsdDecimal(
				line.cost_usd,
				`pricing[${index}].cost_usd`
			),
			...(variant === undefined ? {} : { variant }),
		});
	}
	return {
		provider_slug: providerSlug,
		provider_tag: providerTag,
		supports_streaming: evidenceBoolean(
			value.supports_streaming,
			"supports_streaming"
		),
		supported_parameters: supportedParameters,
		allowed_passthrough_parameters: uniqueStringArray(
			value.allowed_passthrough_parameters,
			"allowed_passthrough_parameters"
		),
		pricing,
	};
}

export function isImageEndpointReady(
	value: ImageEndpointCapabilities
): boolean {
	return value.supports_streaming !== null;
}

export function serializeImagePricingLine(
	line: ImageEndpointPricingLine
): SerializedImageEndpointPricingLine {
	const cost = Number(line.cost_usd);
	if (!Number.isFinite(cost) || cost < 0 || cost > MAX_IMAGE_COST_USD) {
		throw new RangeError(`image cost_usd cannot be represented safely`);
	}
	return { ...line, cost_usd: cost };
}
