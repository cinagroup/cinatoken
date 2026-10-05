/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { adminModelAnalyticsMessages } from '../models/messages'

const en = {
	...adminModelAnalyticsMessages.en,
	title: 'User analytics',
	subtitle:
		'Usage and cost grouped by request-log email for the selected range.',
	loading: 'Loading user analytics…',
	readFailed: 'User analytics could not be loaded.',
	filters: 'User filters',
	emailSearch: 'Email search',
	emailSearchHelp:
		'The main list uses a partial email match; % and _ are wildcards. Model drilldown uses the selected row’s exact email.',
	applyFilters: 'Apply search',
	clearFilters: 'Clear',
	invalidFilter: 'The email search is invalid.',
	budgetScope:
		'Budget figures are current joined-user snapshots grouped by request-log email. They are neither this range’s spend nor a unique account balance.',
	lastActiveUtcFallback:
		'Recent activity is shown in UTC until the business timezone is verified.',
	table: 'User usage table',
	noData: 'No user usage in this range.',
	loadingModels: 'Loading models…',
	noModels: 'No model usage for this email in the selected range.',
	detailFailed: 'Model usage could not be loaded.',
	user_email: 'User email',
	distinct_models: 'Models',
	last_active_at: 'Last active',
	budget_usage_rate: 'Budget usage by email',
	noBudgetRate: 'Unavailable',
	modelLogs: 'Open request logs for {{model}}',
	userLogs: 'Open request logs for {{email}}',
	viewLogs: 'Request logs',
}
const zh: typeof en = {
	...adminModelAnalyticsMessages.zh,
	title: '用户分析',
	subtitle: '按请求日志邮箱汇总所选时段的用量与成本。',
	loading: '正在加载用户分析…',
	readFailed: '无法加载用户分析。',
	filters: '用户筛选',
	emailSearch: '邮箱搜索',
	emailSearchHelp:
		'主列表按邮箱模糊匹配，% 和 _ 是通配符；模型展开仅使用所选行的完整邮箱。',
	applyFilters: '应用搜索',
	clearFilters: '清除',
	invalidFilter: '邮箱搜索条件无效。',
	budgetScope:
		'预算字段是按请求日志邮箱分组的关联用户当前快照，并非所选时段的支出，也不代表唯一账户余额。',
	lastActiveUtcFallback: '确认业务时区前，最近活跃时间按 UTC 显示。',
	table: '用户用量表',
	noData: '此时段没有用户用量。',
	loadingModels: '正在加载模型…',
	noModels: '所选时段内此邮箱没有模型用量。',
	detailFailed: '无法加载模型用量。',
	user_email: '用户邮箱',
	distinct_models: '模型数',
	last_active_at: '最近活跃',
	budget_usage_rate: '按邮箱的预算占用率',
	noBudgetRate: '不可用',
	modelLogs: '打开 {{model}} 的请求日志',
	userLogs: '打开 {{email}} 的请求日志',
	viewLogs: '请求日志',
}
const ja: typeof en = {
	...adminModelAnalyticsMessages.ja,
	title: 'ユーザー分析',
	subtitle:
		'選択期間の使用量とコストをリクエストログのメールアドレス別に集計します。',
	loading: 'ユーザー分析を読み込み中…',
	readFailed: 'ユーザー分析を読み込めませんでした。',
	filters: 'ユーザーの絞り込み',
	emailSearch: 'メールアドレス検索',
	emailSearchHelp:
		'一覧は部分一致で、% と _ はワイルドカードです。モデル内訳には選択した行の正確なメールアドレスを使用します。',
	applyFilters: '検索を適用',
	clearFilters: 'クリア',
	invalidFilter: 'メールアドレスの検索条件が無効です。',
	budgetScope:
		'予算の数値はログのメールアドレスごとに関連付けたユーザーの現在のスナップショットです。選択期間の支出でも単一アカウントの残高でもありません。',
	lastActiveUtcFallback:
		'業務タイムゾーンを確認するまで、最終利用時刻を UTC で表示します。',
	table: 'ユーザー使用量表',
	noData: 'この期間のユーザー使用量はありません。',
	loadingModels: 'モデルを読み込み中…',
	noModels: '選択期間中、このメールアドレスのモデル使用量はありません。',
	detailFailed: 'モデル使用量を読み込めませんでした。',
	user_email: 'メールアドレス',
	distinct_models: 'モデル数',
	last_active_at: '最終利用',
	budget_usage_rate: 'メール別予算使用率',
	noBudgetRate: '利用不可',
	modelLogs: '{{model}} のリクエストログを開く',
	userLogs: '{{email}} のリクエストログを開く',
	viewLogs: 'リクエストログ',
}
const ko: typeof en = {
	...adminModelAnalyticsMessages.ko,
	title: '사용자 분석',
	subtitle: '선택 기간의 사용량과 비용을 요청 로그 이메일별로 집계합니다.',
	loading: '사용자 분석을 불러오는 중…',
	readFailed: '사용자 분석을 불러오지 못했습니다.',
	filters: '사용자 필터',
	emailSearch: '이메일 검색',
	emailSearchHelp:
		'기본 목록은 부분 일치이며 % 와 _ 는 와일드카드입니다. 모델 상세는 선택한 행의 정확한 이메일을 사용합니다.',
	applyFilters: '검색 적용',
	clearFilters: '지우기',
	invalidFilter: '이메일 검색 조건이 잘못되었습니다.',
	budgetScope:
		'예산 수치는 요청 로그 이메일별로 연결된 사용자의 현재 스냅샷입니다. 선택 기간의 지출이나 단일 계정 잔액이 아닙니다.',
	lastActiveUtcFallback:
		'업무 시간대를 확인할 때까지 최근 활동을 UTC로 표시합니다.',
	table: '사용자 사용량 표',
	noData: '이 기간에는 사용자 사용량이 없습니다.',
	loadingModels: '모델을 불러오는 중…',
	noModels: '선택 기간에 이 이메일의 모델 사용량이 없습니다.',
	detailFailed: '모델 사용량을 불러오지 못했습니다.',
	user_email: '사용자 이메일',
	distinct_models: '모델 수',
	last_active_at: '최근 활동',
	budget_usage_rate: '이메일별 예산 사용률',
	noBudgetRate: '사용할 수 없음',
	modelLogs: '{{model}}의 요청 로그 열기',
	userLogs: '{{email}}의 요청 로그 열기',
	viewLogs: '요청 로그',
}

export const adminUserAnalyticsMessages = { en, zh, ja, ko }
