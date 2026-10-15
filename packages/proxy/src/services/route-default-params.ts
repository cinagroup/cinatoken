/**
 * 合并路由级默认参数：`custom_params` 与用户请求体深度合并。
 * 默认用户优先；信封 `force_override.body` 为 true 时路由字段优先。`headers` 不进入请求体。
 */
import { mergeRouteRequestBody } from '@octafuse/core/route-custom-params';
import type { RouteResult } from './model-router';
import { JsonStringPages } from './egress/json-string-pages';

type JsonObject = Record<string, unknown>;

/**
 * 构造发往上游的请求体。
 * @param userBody 客户端 JSON 体（已解析为对象）
 */
export function buildRouteRequestBody(route: RouteResult, userBody: JsonObject): JsonObject {
	const finalBody = mergeRouteRequestBody(route.customParams, userBody);
	const normalized = finalBody;
	const speedControlledBody = route.gatewayTextSpeedControlled ? { ...normalized } : normalized;
	if (route.gatewayTextSpeedControlled) delete speedControlledBody.speed;
	const sessionControlledBody = route.gatewaySessionIdControlled ? { ...speedControlledBody } : speedControlledBody;
	if (route.gatewaySessionIdControlled) delete sessionControlledBody.session_id;
	const withSpeed = route.gatewayTextSpeed
		? { ...sessionControlledBody, speed: route.gatewayTextSpeed }
		: sessionControlledBody;
	// `service_tier` is a gateway routing control. Re-inject only the tier of
	// the verified endpoint chosen for this attempt so a priority fallback to a
	// standard endpoint cannot accidentally ask the provider for priority again.
	const requestedServiceTier = route.gatewayRequestedServiceTier ?? route.gatewayServiceTier;
	return requestedServiceTier ? { ...withSpeed, service_tier: requestedServiceTier } : withSpeed;
}
