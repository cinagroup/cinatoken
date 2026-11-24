/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	catalogOpenReferral: 'Sign up (referral)',
	catalogOpenApiKeys: 'Manage API keys',
	catalogOpenPlatform: 'Open provider website',
	catalogLinkLabel: '{{action}} — {{name}} (opens in a new tab)',
}
type Messages = { [K in keyof typeof en]: string }
export const providerCatalogLinkMessages: Record<
	'en' | 'zh' | 'ja' | 'ko',
	Messages
> = {
	en,
	zh: {
		catalogOpenReferral: '注册（邀请链接）',
		catalogOpenApiKeys: '管理 API 密钥',
		catalogOpenPlatform: '打开供应商官网',
		catalogLinkLabel: '{{action}} — {{name}}（在新标签页中打开）',
	},
	ja: {
		catalogOpenReferral: '登録（紹介リンク）',
		catalogOpenApiKeys: 'API キーを管理',
		catalogOpenPlatform: 'プロバイダーのサイトを開く',
		catalogLinkLabel: '{{action}} — {{name}}（新しいタブで開きます）',
	},
	ko: {
		catalogOpenReferral: '가입하기 (추천 링크)',
		catalogOpenApiKeys: 'API 키 관리',
		catalogOpenPlatform: '공급자 웹사이트 열기',
		catalogLinkLabel: '{{action}} — {{name}} (새 탭에서 열림)',
	},
}
