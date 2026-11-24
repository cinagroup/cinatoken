/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	resolvedPricing: 'Resolved per-request prices',
	pricePerRequest: 'Prices per request',
	priceBelowMetered: 'The charged price is below the metered cost per request.',
}
const zh: Record<keyof typeof en, string> = {
	resolvedPricing: '计算后的每请求单价',
	pricePerRequest: '每次请求的单价',
	priceBelowMetered: '每次请求的实收单价低于计量成本单价。',
}
const ja: Record<keyof typeof en, string> = {
	resolvedPricing: '計算済みのリクエスト単価',
	pricePerRequest: 'リクエストあたりの単価',
	priceBelowMetered: 'リクエストあたりの請求単価が計量コストを下回っています。',
}
const ko: Record<keyof typeof en, string> = {
	resolvedPricing: '계산된 요청당 단가',
	pricePerRequest: '요청당 단가',
	priceBelowMetered: '요청당 청구 단가가 계량 비용보다 낮습니다.',
}

export const mcpPricingSummaryMessages = { en, zh, ja, ko }
