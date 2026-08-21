/**
 * 共享密钥上架校验：调用官方渠道 models 列表端点验证 key 有效性。
 * 2xx → 有效；401/403 → 无效；网络/5xx → 校验不可用（卖家可重试）。
 */
import { getSharedChannelDefinition } from '@octafuse/core';

export type SharedKeyValidationResult = {
	/** key 被官方端点确认有效/无效 */
	valid: boolean;
	/** true = 端点不可达/非鉴权错误，无法下结论（保持 validating） */
	inconclusive: boolean;
	reason: string | null;
};

const VALIDATION_TIMEOUT_MS = 15_000;

export async function validateSharedKey(
	channelType: string,
	apiKey: string,
): Promise<SharedKeyValidationResult> {
	const definition = getSharedChannelDefinition(channelType);
	if (!definition) return { valid: false, inconclusive: false, reason: `unsupported channel: ${channelType}` };
	if (!apiKey.trim()) return { valid: false, inconclusive: false, reason: 'empty api key' };

	const headers: Record<string, string> = {
		...(definition.authStyle === 'bearer'
			? { authorization: `Bearer ${apiKey.trim()}` }
			: { 'x-api-key': apiKey.trim() }),
		...(definition.extraHeaders ?? {}),
	};

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
	try {
		const response = await fetch(definition.modelsUrl, {
			method: 'GET',
			headers,
			cache: 'no-store',
			signal: controller.signal,
		});
		if (response.ok) return { valid: true, inconclusive: false, reason: null };
		if (response.status === 401 || response.status === 403) {
			return { valid: false, inconclusive: false, reason: `upstream rejected key (HTTP ${response.status})` };
		}
		// 其余非 2xx 视为校验不可用
		return { valid: false, inconclusive: true, reason: `validation endpoint returned HTTP ${response.status}` };
	} catch (error) {
		return {
			valid: false,
			inconclusive: true,
			reason: error instanceof Error ? `validation request failed: ${error.message}` : 'validation request failed',
		};
	} finally {
		clearTimeout(timeout);
	}
}
