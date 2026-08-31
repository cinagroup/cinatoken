/**
 * 各表允许通过 patch 接口更新的列名白名单（snake_case，与数据库列名一致）。
 * 所有 updateXxxByPatch 函数在拼接 `SET col = ?` 之前必须用本文件的集合过滤列名，
 * 防止传入任意字符串被拼入 SQL。
 */

export const PROVIDER_PATCH_COLS = new Set(['name', 'endpoints', 'description', 'api_key', 'status', 'shared_channel_type']);

export const MODEL_PATCH_COLS = new Set([
	'display_name',
	'vendor',
	'context_window',
	'max_tokens',
	'pricing_profile',
	'description',
	'metadata',
	'input_modalities',
	'output_modalities',
	'released_at',
	'route_policy',
]);

export const MODEL_ROUTE_PATCH_COLS = new Set([
	'model_id',
	'provider_id',
	'provider_model_name',
	'priority',
	'status',
	'route_group',
	'weight',
	'price_override',
	'custom_params',
	'routing_metadata',
	'upstream_protocol',
	'route_pool_id',
	'upstream_operation',
	'adapter',
]);

export const MODEL_ENDPOINT_PATCH_COLS = new Set([
	'model_id',
	'provider_id',
	'provider_slug',
	'tag',
	'endpoint_class',
	'region',
	'context_length',
	'max_prompt_tokens',
	'max_completion_tokens',
	'quantization',
	'supported_parameters',
	'pricing',
	'supports_implicit_caching',
	'supports_voice_cloning',
	'supports_tool_choice',
	'image_capabilities',
	'audio_capabilities',
	'evidence_url',
	'verified_by',
	'verified_at',
	'expires_at',
	'status',
	'updated_at',
]);
