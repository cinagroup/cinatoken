/**
 * OpenAI Images generations 兼容扩展字段（Seedream 等）。
 * 用户显式传入才写入；路由默认值仍由 `buildRouteRequestBody` + `custom_params` 合并。
 */
import { hasJsonStringContent, isJsonString, JsonStringPages, trimJsonString } from './egress/json-string-pages';

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
