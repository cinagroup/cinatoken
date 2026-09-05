/**
 * Gateway 错误细分类 code（点分层级）。
 *
 * - `gateway.*` — 请求未出网关
 * - `circuit.*` — 熔断短路（未打上游）
 * - `upstream.*` — 已打上游，网关分类后透传
 *
 * 约定：公开 body 使用稳定的 OpenRouter 嵌套错误协议；历史点分 code
 * 仅作为顶层兼容字段与 `X-OctaFuse-Error-Code` 响应头保留。
 */

export const GATEWAY_ERROR_CODE_HEADER = "X-OctaFuse-Error-Code";

export const GatewayErrorCode = {
	// gateway.*
	invalidJson: "gateway.invalid_json",
	missingModel: "gateway.missing_model",
	modelNotFound: "gateway.model_not_found",
	budgetExceeded: "gateway.budget_exceeded",
	authFailed: "gateway.auth_failed",
	permissionDenied: "gateway.permission_denied",
	authRateLimited: "gateway.auth_rate_limited",
	publicCatalogRateLimited: "gateway.public_catalog_rate_limited",
	analyticsRateLimited: "gateway.analytics_rate_limited",
	publicCatalogUnavailable: "gateway.public_catalog_unavailable",
	internalError: "gateway.internal_error",
	routeNotFound: "gateway.route_not_found",
	payloadTooLarge: "gateway.payload_too_large",
	noRoute: "gateway.no_route",
	routeResolutionFailed: "gateway.route_resolution_failed",
	invalidRequest: "gateway.invalid_request",
	resourceConflict: "gateway.resource_conflict",
	invalidPresetReference: "gateway.invalid_preset_reference",
	presetNotFound: "gateway.preset_not_found",
	presetInvalid: "gateway.preset_invalid",
	guardrailBlocked: "gateway.guardrail_blocked",
	guardrailInvalid: "gateway.guardrail_invalid",
	zdrNoRoute: "gateway.zdr_no_route",
	dataCollectionNoRoute: "gateway.data_collection_no_route",
	zdrToolsUnsupported: "gateway.zdr_tools_unsupported",
	upstreamRequestFailed: "gateway.upstream_request_failed",
	upstreamResponseTooLarge: "gateway.upstream_response_too_large",
	responsesStateRouteUnavailable: "responses.state_route_unavailable",
	responsesUnsupportedStateOperation: "responses.unsupported_state_operation",

	// circuit.*
	circuitSensitiveContent: "circuit.sensitive_content",
	circuitClientError: "circuit.client_error",
	circuitUpstreamCapacityExhausted: "circuit.upstream_capacity_exhausted",

	// upstream.*
	upstreamContentFilter: "upstream.content_filter",
	upstreamInvalidRequest: "upstream.invalid_request",
	upstreamRateLimited: "upstream.rate_limited",
	upstreamAuthFailed: "upstream.auth_failed",
	upstreamNotFound: "upstream.not_found",
	upstreamServerError: "upstream.server_error",
	upstreamTimeout: "upstream.timeout",
} as const;

export type GatewayErrorCodeValue =
	(typeof GatewayErrorCode)[keyof typeof GatewayErrorCode];
