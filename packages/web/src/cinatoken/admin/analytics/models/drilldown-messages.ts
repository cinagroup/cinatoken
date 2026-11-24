/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	drilldownExpanded: 'Expanded detail rows: {{count}}',
	collapseDetails: 'Collapse all details',
	toggleModelDetails: 'Toggle provider details for {{model}} in {{group}}',
	toggleProviderDetails: 'Toggle model details for {{provider}} ({{id}})',
}
const zh: typeof en = {
	drilldownExpanded: '已展开 {{count}} 项明细',
	collapseDetails: '收起全部明细',
	toggleModelDetails:
		'展开或收起模型 {{model}}（路由组 {{group}}）的供应商明细',
	toggleProviderDetails: '展开或收起供应商 {{provider}}（{{id}}）的模型明细',
}
const ja: typeof en = {
	drilldownExpanded: '{{count}} 件の詳細を展開中',
	collapseDetails: 'すべての詳細を閉じる',
	toggleModelDetails: '{{group}} の {{model}} のプロバイダー詳細を開閉',
	toggleProviderDetails: '{{provider}}（{{id}}）のモデル詳細を開閉',
}
const ko: typeof en = {
	drilldownExpanded: '상세 내역 {{count}}개 펼침',
	collapseDetails: '모든 상세 내역 접기',
	toggleModelDetails: '{{group}}의 {{model}} 공급자 상세 내역 펼치기 또는 접기',
	toggleProviderDetails:
		'{{provider}}({{id}})의 모델 상세 내역 펼치기 또는 접기',
}
export const analyticsDrilldownMessages = { en, zh, ja, ko }
