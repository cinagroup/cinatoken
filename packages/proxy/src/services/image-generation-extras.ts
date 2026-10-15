/**
 * OpenAI Images generations 兼容扩展字段（Seedream 等）。
 * 用户显式传入才写入；路由默认值仍由 `buildRouteRequestBody` + `custom_params` 合并。
 */
import { hasJsonStringContent, isJsonString, JsonStringPages, trimJsonString, materializeJsonStringTree } from './egress/json-string-pages';

/** JSON generations 请求体中的参考图张数（`image` 字符串或字符串数组）。 */
export function countOpenAiGenerationReferenceImages(body: Record<string, unknown>): number {
	const image = body.image;
	if (hasJsonStringContent(image)) {
		return 1;
	}
	if (Array.isArray(image)) {
		return image.filter(hasJsonStringContent).length;
	}
	return 0;
}

/**
 * 按张计费用的尺寸档：优先 OpenAI `size`；未传时取扩展字段 `resolution`（xAI Grok Imagine 用它选 1k/2k）；都没有则 `auto`。
 */
export function openAiImageBillingSize(
	size: string | undefined,
	extra: Record<string, unknown> | undefined
): string {
	if (size) {
		return size;
	}
	const resolution = extra?.resolution;
	if (typeof resolution === 'string' && resolution.trim() !== '') {
		return resolution.trim().toLowerCase();
	}
	return 'auto';
}

/**
 * 将 OpenAI Images generations 的兼容扩展字段写入上游体。
 * 覆盖：`watermark` / `sequential_image_generation*` / `image` / `optimize_prompt_options`。
 */
export function applyOpenAiImageGenerationExtras(
	upstreamBody: Record<string, unknown>,
	body: Record<string, unknown>
): void {
	if (typeof body.watermark === 'boolean') {
		upstreamBody.watermark = body.watermark;
	}
	if (
		isJsonString(body.sequential_image_generation) &&
		hasJsonStringContent(body.sequential_image_generation)
	) {
		upstreamBody.sequential_image_generation = trimJsonString(body.sequential_image_generation);
	}
	if (
		body.sequential_image_generation_options &&
		typeof body.sequential_image_generation_options === 'object' &&
		!(body.sequential_image_generation_options instanceof JsonStringPages) &&
		!Array.isArray(body.sequential_image_generation_options)
	) {
		upstreamBody.sequential_image_generation_options = body.sequential_image_generation_options;
	}
	if (
		body.optimize_prompt_options &&
		typeof body.optimize_prompt_options === 'object' &&
		!(body.optimize_prompt_options instanceof JsonStringPages) &&
		!Array.isArray(body.optimize_prompt_options)
	) {
		upstreamBody.optimize_prompt_options = body.optimize_prompt_options;
	}
	// Seedream 图生图 / 多图融合：JSON `image`（URL 或 data URL / 数组）；非 multipart edits
	if (isJsonString(body.image) && hasJsonStringContent(body.image)) {
		upstreamBody.image = trimJsonString(body.image);
	} else if (Array.isArray(body.image)) {
		const images = body.image
			.filter((v): v is string | JsonStringPages => isJsonString(v) && hasJsonStringContent(v))
			.map(trimJsonString);
		if (images.length > 0) {
			upstreamBody.image = images.length === 1 ? images[0] : images;
		}
	}
}

/** Verified endpoint passthrough declarations bound additional fields before serialization. */
export function imageGenerationDeclaredExtraBody(
 body: Record<string, unknown>,
 routes: readonly { endpoint?: { imageCapabilities?: { allowed_passthrough_parameters: readonly string[] } | null } | null }[],
): Record<string, unknown> {
 if (!routes.length || routes.some(route => !route.endpoint)) return body;
 const allowed = new Set((routes[0]?.endpoint?.imageCapabilities?.allowed_passthrough_parameters ?? []).filter(path => routes.every(route => route.endpoint?.imageCapabilities?.allowed_passthrough_parameters.includes(path))));
 const result: Record<string, unknown> = {};
 for (const path of allowed) {
  const parts = path.split('.');
  if (parts.some(part => !part || ['__proto__','constructor','prototype'].includes(part))) continue;
  let value: unknown = body;
  for (const part of parts) {
   if (!value || typeof value !== 'object' || !Object.hasOwn(value,part)) { value = undefined; break; }
   value = (value as Record<string,unknown>)[part];
  }
  if (value === undefined) continue;
  // Paged ingress strings must remain bounded before JSON.stringify can materialize them.
  const pending: unknown[] = [value];
  let nodes = 0;
  while (pending.length) {
   const item = pending.pop();
   if (++nodes > 16_384 || item instanceof JsonStringPages && item.length > 32_768) {
    throw new RangeError('Declared image extra fields exceed the bounded passthrough limit');
   }
   if (item && typeof item === 'object' && !(item instanceof JsonStringPages)) pending.push(...Object.values(item));
  }
  let target = result;
  for (const part of parts.slice(0,-1)) {
   const current = target[part];
   target = (target[part] = current && typeof current === 'object' && !Array.isArray(current) ? current : {}) as Record<string,unknown>;
  }
  target[parts.at(-1)!] = materializeJsonStringTree(value);
 }
 return result;
}
