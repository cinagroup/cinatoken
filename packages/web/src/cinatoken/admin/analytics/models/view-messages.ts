/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	viewLabel: 'Column view',
	viewOverview: 'Overview',
	viewCost: 'Cost',
	viewPerformance: 'Performance',
	viewAll: 'All columns',
	viewSearchModels: 'Search models or route groups',
	viewSearchProviders: 'Search provider names, IDs or types',
	viewSearchHint:
		'Searches only the rows already loaded for this range. No new server request is sent.',
	viewMatching: '{{matched}} of {{total}} loaded rows match',
	viewClearSearch: 'Clear search',
	viewNoMatches:
		'No rows match the current search or filters. Clear or change them to show results.',
	viewCsvHint:
		'CSV exports only rows matching the current filters, with all columns regardless of the selected view.',
}
const zh: typeof en = {
	viewLabel: '列视图',
	viewOverview: '概览',
	viewCost: '成本',
	viewPerformance: '性能',
	viewAll: '全部列',
	viewSearchModels: '搜索模型或路由组',
	viewSearchProviders: '搜索供应商名称、ID 或类型',
	viewSearchHint: '仅搜索此时段已加载的数据行，不会发送新的服务端请求。',
	viewMatching: '已加载 {{total}} 行，匹配 {{matched}} 行',
	viewClearSearch: '清除搜索',
	viewNoMatches: '当前搜索或筛选没有匹配结果，请清除或修改搜索和筛选条件。',
	viewCsvHint: 'CSV 仅导出当前筛选匹配行，并保留全部列，不受所选视图影响。',
}
const ja: typeof en = {
	viewLabel: '列の表示',
	viewOverview: '概要',
	viewCost: 'コスト',
	viewPerformance: '性能',
	viewAll: 'すべての列',
	viewSearchModels: 'モデルまたはルートグループを検索',
	viewSearchProviders: 'プロバイダー名、ID、種類を検索',
	viewSearchHint:
		'この期間に読み込み済みの行のみを検索します。サーバーへの新しいリクエストは送信しません。',
	viewMatching: '読み込み済み {{total}} 行のうち {{matched}} 行が一致',
	viewClearSearch: '検索をクリア',
	viewNoMatches:
		'現在の検索や絞り込み条件に一致する行はありません。条件を解除するか変更してください。',
	viewCsvHint:
		'CSV は現在の条件に一致する行のみを、選択した表示に関係なくすべての列で出力します。',
}
const ko: typeof en = {
	viewLabel: '열 보기',
	viewOverview: '개요',
	viewCost: '비용',
	viewPerformance: '성능',
	viewAll: '모든 열',
	viewSearchModels: '모델 또는 라우트 그룹 검색',
	viewSearchProviders: '공급자 이름, ID 또는 유형 검색',
	viewSearchHint:
		'이 기간에 이미 불러온 행만 검색합니다. 서버에 새 요청을 보내지 않습니다.',
	viewMatching: '불러온 {{total}}개 행 중 {{matched}}개 일치',
	viewClearSearch: '검색 지우기',
	viewNoMatches:
		'현재 검색이나 필터 조건과 일치하는 행이 없습니다. 조건을 지우거나 변경하세요.',
	viewCsvHint:
		'CSV는 현재 필터와 일치하는 행만 내보내며, 선택한 보기에 관계없이 모든 열을 포함합니다.',
}
export const analyticsViewMessages = { en, zh, ja, ko }
