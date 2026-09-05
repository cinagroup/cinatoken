/**
 * 合并路由级默认参数：`custom_params` 与用户请求体深度合并（用户优先）。
 */
import type { RouteResult } from './model-router';

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMergeDefaults(defaultValue: unknown, userValue: unknown): unknown {
  if (userValue !== undefined) {
    if (Array.isArray(userValue)) {
      return userValue;
    }
    if (isPlainObject(defaultValue) && isPlainObject(userValue)) {
      const merged: JsonObject = {};
      const keys = new Set([...Object.keys(defaultValue), ...Object.keys(userValue)]);
      for (const key of keys) {
        merged[key] = deepMergeDefaults(defaultValue[key], userValue[key]);
      }
      return merged;
    }
    return userValue;
  }

  return defaultValue;
}

/**
 * 构造发往上游的请求体。优先级：用户字段 > route `custom_params`。
 * @param userBody 客户端 JSON 体（已解析为对象）
 */
export function buildRouteRequestBody(
  route: RouteResult,
  userBody: JsonObject
): JsonObject {
  const finalBody = deepMergeDefaults(route.customParams ?? {}, userBody);
  const normalized = isPlainObject(finalBody) ? finalBody : { ...userBody };
	const speedControlledBody = route.gatewayTextSpeedControlled
		? { ...normalized }
		: normalized;
	if (route.gatewayTextSpeedControlled) delete speedControlledBody.speed;
	const sessionControlledBody = route.gatewaySessionIdControlled
		? { ...speedControlledBody }
		: speedControlledBody;
	if (route.gatewaySessionIdControlled) delete sessionControlledBody.session_id;
	const withSpeed = route.gatewayTextSpeed
		? { ...sessionControlledBody, speed: route.gatewayTextSpeed }
		: sessionControlledBody;
  // `service_tier` is a gateway routing control. Re-inject only the tier of
  // the verified endpoint chosen for this attempt so a priority fallback to a
  // standard endpoint cannot accidentally ask the provider for priority again.
  const requestedServiceTier = route.gatewayRequestedServiceTier ?? route.gatewayServiceTier;
  return requestedServiceTier
    ? { ...withSpeed, service_tier: requestedServiceTier }
    : withSpeed;
}
