/**
 * 用户共享密钥渠道白名单：只允许注入"官方渠道"的个人 API Key。
 *
 * `shared_keys.channel_type` 与 `providers.shared_channel_type` 共用本常量的键。
 * 校验一律打到官方 API 的 models 列表端点（低成本、无 token 消耗）。
 */
import type { SharedKeyChannelType } from './db/shared-keys-types';

export type SharedChannelDefinition = {
	/** 展示名 */
	label: string;
	/** 校验用 models 列表端点 */
	modelsUrl: string;
	/** `bearer`（OpenAI 风格 Authorization）或 `x_api_key`（Anthropic 风格） */
	authStyle: 'bearer' | 'x_api_key';
	/** 额外请求头（Anthropic 需要 version 头） */
	extraHeaders?: Record<string, string>;
};

export const SHARED_CHANNEL_DEFINITIONS: Record<SharedKeyChannelType, SharedChannelDefinition> = {
	openai: {
		label: 'OpenAI (ChatGPT)',
		modelsUrl: 'https://api.openai.com/v1/models',
		authStyle: 'bearer',
	},
	anthropic: {
		label: 'Anthropic (Claude)',
		modelsUrl: 'https://api.anthropic.com/v1/models',
		authStyle: 'x_api_key',
		extraHeaders: { 'anthropic-version': '2023-06-01' },
	},
	zhipu: {
		label: '智谱 GLM',
		modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
		authStyle: 'bearer',
	},
	deepseek: {
		label: 'DeepSeek',
		modelsUrl: 'https://api.deepseek.com/models',
		authStyle: 'bearer',
	},
};

export function getSharedChannelDefinition(channelType: string): SharedChannelDefinition | null {
	return Object.prototype.hasOwnProperty.call(SHARED_CHANNEL_DEFINITIONS, channelType)
		? SHARED_CHANNEL_DEFINITIONS[channelType as SharedKeyChannelType]
		: null;
}
