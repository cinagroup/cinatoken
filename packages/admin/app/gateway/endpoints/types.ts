import type {
	AudioEndpointCapabilities,
	EndpointToolChoiceSupport,
	ImageEndpointCapabilities,
	TextEndpointPricing,
} from "@octafuse/core/model-endpoint-catalog";

export type EndpointStatus = "draft" | "verified" | "disabled";
export type TriState = "unknown" | "true" | "false";

export type EndpointListItem = {
	id: string;
	model_id: string;
	provider_id: string;
	provider_slug: string;
	tag: string;
	endpoint_class: string | null;
	region: string | null;
	context_length: number | null;
	max_prompt_tokens: number | null;
	max_completion_tokens: number | null;
	quantization: string | null;
	supported_parameters: string[];
	pricing: TextEndpointPricing | null;
	supports_implicit_caching: boolean | null;
	supports_voice_cloning: boolean | null;
	supports_tool_choice: EndpointToolChoiceSupport;
	image_capabilities: ImageEndpointCapabilities | null;
	audio_capabilities: AudioEndpointCapabilities | null;
	evidence_url: string | null;
	verified_by: string | null;
	verified_at: string | null;
	expires_at: string | null;
	status: EndpointStatus;
	created_at: string;
	updated_at: string;
	route_target_ids: string[];
};

export type EndpointModelOption = {
	id: string;
	display_name?: string | null;
	vendor?: string | null;
};

export type EndpointProviderOption = {
	id: string;
	name?: string | null;
};

export type EndpointRouteOption = {
	id: string;
	model_id: string;
	provider_id: string;
	provider_name?: string | null;
	provider_model_name?: string | null;
	status?: string | null;
};

export type EndpointFormState = {
	model_id: string;
	provider_id: string;
	provider_slug: string;
	tag: string;
	endpoint_class: "" | "standard" | "service_tier";
	region: string;
	context_length: string;
	max_prompt_tokens: string;
	max_completion_tokens: string;
	quantization: string;
	supported_parameters: string;
	prompt_price: string;
	completion_price: string;
	request_price: string;
	image_price: string;
	image_output_price: string;
	input_cache_read_price: string;
	input_cache_write_price: string;
	pricing_extras_json: string;
	implicit_caching: TriState;
	voice_cloning: TriState;
	tool_choice_auto: TriState;
	tool_choice_function: TriState;
	tool_choice_none: TriState;
	tool_choice_required: TriState;
	image_capabilities_json: string;
	audio_capabilities_json: string;
	evidence_url: string;
	expires_at: string;
	status: EndpointStatus;
};

export const EMPTY_ENDPOINT_FORM: EndpointFormState = {
	model_id: "",
	provider_id: "",
	provider_slug: "",
	tag: "",
	endpoint_class: "standard",
	region: "",
	context_length: "",
	max_prompt_tokens: "",
	max_completion_tokens: "",
	quantization: "",
	supported_parameters: "",
	prompt_price: "",
	completion_price: "",
	request_price: "",
	image_price: "",
	image_output_price: "",
	input_cache_read_price: "",
	input_cache_write_price: "",
	pricing_extras_json: "",
	implicit_caching: "unknown",
	voice_cloning: "unknown",
	tool_choice_auto: "unknown",
	tool_choice_function: "unknown",
	tool_choice_none: "unknown",
	tool_choice_required: "unknown",
	image_capabilities_json: "",
	audio_capabilities_json: "",
	evidence_url: "",
	expires_at: "",
	status: "draft",
};
