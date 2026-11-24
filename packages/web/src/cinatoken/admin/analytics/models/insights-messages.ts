/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	insightsTitle: 'Matching rows summary',
	insightsRequests: 'Requests',
	insightsSuccessRate: 'Success rate',
	insightsErrors: 'Failed requests',
	insightsCostDifference: 'Charge − cost',
	insightsNoSamples: 'No requests',
	insightsOutcomes:
		'Succeeded: {{success}} · Failed: {{errors}} · Other: {{other}}',
	insightsDefinitions: 'Scope and calculation',
	insightsScopeModels:
		'Totals cover rows matching the current time range, server filters and local search, grouped by model and route group. Requests without a model are excluded.',
	insightsScopeProviders:
		'Totals cover rows matching the current time range, server filters and local search, attributed to the final provider in each request log. Earlier attempts are not separate samples. Requests without a provider are excluded.',
	insightsRateNote:
		'Success rate is total successful requests divided by total requests. Row percentages are not averaged.',
	insightsOtherNote:
		'Other is total requests minus successful and failed requests. It includes the remaining recorded outcomes.',
	insightsCostNote:
		'Charge − cost is the recorded charged amount minus metered cost. It is not net profit: infrastructure, taxes and unrecorded costs are not deducted. Standard cost does not enter this difference.',
}
const zh: typeof en = {
	insightsTitle: '匹配行汇总',
	insightsRequests: '请求数',
	insightsSuccessRate: '成功率',
	insightsErrors: '失败请求数',
	insightsCostDifference: '实收 − 计量成本',
	insightsNoSamples: '无请求',
	insightsOutcomes: '成功：{{success}} · 失败：{{errors}} · 其他：{{other}}',
	insightsDefinitions: '统计范围与计算方式',
	insightsScopeModels:
		'汇总当前时间范围、服务端筛选和本地搜索后匹配的数据行，按模型与路由组分组，不包含没有模型的请求。',
	insightsScopeProviders:
		'汇总当前时间范围、服务端筛选和本地搜索后匹配的数据行，归属于每条请求日志中的最终供应商。此前的尝试不单独计为样本，不包含没有供应商的请求。',
	insightsRateNote: '成功率为成功请求总数除以请求总数，不对各行百分比求平均。',
	insightsOtherNote:
		'其他为请求总数减去成功和失败请求数，包含剩余已记录的请求结果。',
	insightsCostNote:
		'差额为已记录的实收金额减去计量成本，并非净利润：尚未扣除基础设施、税费和未记录的成本。标准费用不参与此差额计算。',
}
const ja: typeof en = {
	insightsTitle: '一致する行の集計',
	insightsRequests: 'リクエスト数',
	insightsSuccessRate: '成功率',
	insightsErrors: '失敗したリクエスト',
	insightsCostDifference: '請求額 − 計測コスト',
	insightsNoSamples: 'リクエストなし',
	insightsOutcomes: '成功：{{success}} · 失敗：{{errors}} · その他：{{other}}',
	insightsDefinitions: '集計範囲と計算方法',
	insightsScopeModels:
		'現在の期間、サーバー側の絞り込み、ローカル検索に一致する行を、モデルとルートグループごとに集計します。モデルのないリクエストは含みません。',
	insightsScopeProviders:
		'現在の期間、サーバー側の絞り込み、ローカル検索に一致する行を、各リクエストログの最終プロバイダーに帰属させて集計します。それ以前の試行は個別のサンプルとして数えず、プロバイダーのないリクエストは含みません。',
	insightsRateNote:
		'成功率は成功したリクエストの合計を全リクエストの合計で割った値です。各行の割合の平均ではありません。',
	insightsOtherNote:
		'その他は全リクエスト数から成功と失敗の件数を引いた値で、残りの記録済み結果を含みます。',
	insightsCostNote:
		'差額は記録された請求額から計測コストを引いた値です。インフラ、税金、未記録の費用を差し引いていないため、純利益ではありません。標準料金はこの差額の計算に含みません。',
}
const ko: typeof en = {
	insightsTitle: '일치하는 행 요약',
	insightsRequests: '요청 수',
	insightsSuccessRate: '성공률',
	insightsErrors: '실패한 요청',
	insightsCostDifference: '청구액 − 측정 비용',
	insightsNoSamples: '요청 없음',
	insightsOutcomes: '성공: {{success}} · 실패: {{errors}} · 기타: {{other}}',
	insightsDefinitions: '집계 범위와 계산 방식',
	insightsScopeModels:
		'현재 기간, 서버 필터 및 로컬 검색에 일치하는 행을 모델과 라우트 그룹별로 집계합니다. 모델이 없는 요청은 제외합니다.',
	insightsScopeProviders:
		'현재 기간, 서버 필터 및 로컬 검색에 일치하는 행을 각 요청 로그의 최종 공급자에 귀속하여 집계합니다. 이전 시도는 별도 표본으로 세지 않으며 공급자가 없는 요청은 제외합니다.',
	insightsRateNote:
		'성공률은 성공한 요청의 합계를 전체 요청의 합계로 나눈 값입니다. 각 행의 백분율을 평균내지 않습니다.',
	insightsOtherNote:
		'기타는 전체 요청 수에서 성공 및 실패 요청 수를 뺀 값으로, 나머지 기록된 결과를 포함합니다.',
	insightsCostNote:
		'차액은 기록된 청구액에서 측정 비용을 뺀 값입니다. 인프라, 세금 및 기록되지 않은 비용을 차감하지 않았으므로 순이익이 아닙니다. 표준 요금은 이 차액 계산에 포함하지 않습니다.',
}
export const analyticsInsightsMessages = { en, zh, ja, ko }
