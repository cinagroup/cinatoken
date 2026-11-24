/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	viewBudget: 'Budget & wallet',
	viewSearchUsers: 'Search loaded emails',
	viewSearchUsersHint:
		'Filter the loaded rows by email, ignoring case. All characters, including % and _, are literal. This does not send a new request.',
	toggleUserModels: 'Toggle model usage for {{email}}',
	toggleUserKeys: 'Toggle Key usage for {{email}}',
	toggleKeyModels: 'Toggle model usage for {{name}} ({{id}}), {{email}}',
	insightsUnknown: 'Not reported',
	insightsScopeUsers:
		'These totals cover the matching request-log email groups in the selected time range. Key drilldowns cover the exact account across its historical log emails and are not added to these totals.',
	insightsExactCounts:
		'The summary success rate uses total reported successes divided by total requests. If any row omits its success count, the summary success rate, success count and other count remain unknown; row percentages are not used to estimate counts.',
}
const zh: typeof en = {
	viewBudget: '预算与钱包',
	viewSearchUsers: '搜索已加载邮箱',
	viewSearchUsersHint:
		'按邮箱筛选已加载行，不区分大小写；包括 % 和 _ 在内的字符均按字面匹配，不发送新请求。',
	toggleUserModels: '展开或收起 {{email}} 的模型用量',
	toggleUserKeys: '展开或收起 {{email}} 的 Key 用量',
	toggleKeyModels: '展开或收起 {{email}} 的 {{name}}（{{id}}）模型用量',
	insightsUnknown: '未报告',
	insightsScopeUsers:
		'汇总覆盖所选时段内匹配的请求日志邮箱分组。Key 下钻覆盖精确账号的所有历史日志邮箱，不额外计入此汇总。',
	insightsExactCounts:
		'汇总成功率按已报告成功数之和除以请求数之和计算。任一行未提供成功数时，汇总成功率、成功数和其他结果数均保留未知，不按行百分比估算次数。',
}
const ja: typeof en = {
	viewBudget: '予算とウォレット',
	viewSearchUsers: '読み込んだメールを検索',
	viewSearchUsersHint:
		'読み込み済みの行をメールで絞り込みます。大文字小文字を区別せず、% と _ を含む文字はそのまま照合し、新しいリクエストは送信しません。',
	toggleUserModels: '{{email}} のモデル使用量を開閉',
	toggleUserKeys: '{{email}} の Key 使用量を開閉',
	toggleKeyModels: '{{email}} の {{name}}（{{id}}）のモデル使用量を開閉',
	insightsUnknown: '未報告',
	insightsScopeUsers:
		'集計は選択期間の一致するリクエストログのメールグループが対象です。Key 詳細は正確なアカウントの過去の全メールを対象とし、この集計には加算しません。',
	insightsExactCounts:
		'集計成功率は報告された成功数の合計をリクエスト総数で割って計算します。成功数が未提供の行がある場合、集計成功率・成功数・その他の件数は不明のままとし、行の割合から推定しません。',
}
const ko: typeof en = {
	viewBudget: '예산 및 지갑',
	viewSearchUsers: '불러온 이메일 검색',
	viewSearchUsersHint:
		'불러온 행을 이메일로 필터링합니다. 대소문자를 구분하지 않으며 %와 _도 문자 그대로 검색하고 새 요청을 보내지 않습니다.',
	toggleUserModels: '{{email}} 모델 사용량 펼치기 또는 접기',
	toggleUserKeys: '{{email}} Key 사용량 펼치기 또는 접기',
	toggleKeyModels: '{{email}}의 {{name}}({{id}}) 모델 사용량 펼치기 또는 접기',
	insightsUnknown: '보고되지 않음',
	insightsScopeUsers:
		'합계는 선택한 기간에 일치하는 요청 로그 이메일 그룹을 대상으로 합니다. Key 상세는 해당 계정의 모든 과거 로그 이메일을 포함하며 이 합계에 추가하지 않습니다.',
	insightsExactCounts:
		'전체 성공률은 보고된 성공 건수 합계를 전체 요청 수로 나누어 계산합니다. 성공 건수가 없는 행이 있으면 전체 성공률, 성공 및 기타 건수는 알 수 없음으로 유지하며 행 비율로 추정하지 않습니다.',
}
export const userAnalyticsComparisonMessages = { en, zh, ja, ko }
