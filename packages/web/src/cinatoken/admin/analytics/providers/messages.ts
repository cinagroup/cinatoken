/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { adminModelAnalyticsMessages } from '../models/messages'

const en = {
	...adminModelAnalyticsMessages.en,
	title: 'Provider analytics',
	subtitle: 'Usage, cost, latency and model drilldown for the selected range.',
	loading: 'Loading provider analytics…',
	readFailed: 'Provider analytics could not be loaded.',
	filters: 'Provider filters',
	table: 'Provider usage table',
	noData: 'No provider usage in this range.',
	loadingModels: 'Loading models…',
	noModels: 'No model usage for this provider.',
	detailFailed: 'Model usage could not be loaded.',
	provider_name: 'Provider',
	model_id: 'Model',
	route_group: 'Route group',
	logsUnfilteredTag:
		'Request Logs do not support tag filtering. Linked logs may include other tags.',
	modelLogs: 'Open request logs for {{model}}',
}
const zh: typeof en = {
	...adminModelAnalyticsMessages.zh,
	title: '供应商分析',
	subtitle: '查看所选时段的用量、成本、延迟和模型明细。',
	loading: '正在加载供应商分析…',
	readFailed: '无法加载供应商分析。',
	filters: '供应商筛选',
	table: '供应商用量表',
	noData: '此时段没有供应商用量。',
	loadingModels: '正在加载模型…',
	noModels: '此供应商没有模型用量。',
	detailFailed: '无法加载模型用量。',
	provider_name: '供应商',
	model_id: '模型',
	route_group: '路由组',
	logsUnfilteredTag: '请求日志不支持标签筛选。链接中的日志可能包含其他标签。',
	modelLogs: '打开 {{model}} 的请求日志',
}
const ja: typeof en = {
	...adminModelAnalyticsMessages.ja,
	title: 'プロバイダー分析',
	subtitle: '選択期間の使用量、コスト、遅延、モデル内訳を表示します。',
	loading: 'プロバイダー分析を読み込み中…',
	readFailed: 'プロバイダー分析を読み込めませんでした。',
	filters: 'プロバイダーの絞り込み',
	table: 'プロバイダー使用量表',
	noData: 'この期間のプロバイダー使用量はありません。',
	loadingModels: 'モデルを読み込み中…',
	noModels: 'このプロバイダーのモデル使用量はありません。',
	detailFailed: 'モデル使用量を読み込めませんでした。',
	provider_name: 'プロバイダー',
	model_id: 'モデル',
	route_group: 'ルートグループ',
	logsUnfilteredTag:
		'リクエストログはタグで絞り込めません。リンク先に他のタグのログが含まれる場合があります。',
	modelLogs: '{{model}} のリクエストログを開く',
}
const ko: typeof en = {
	...adminModelAnalyticsMessages.ko,
	title: '공급자 분석',
	subtitle:
		'선택 기간의 사용량, 비용, 지연 시간과 모델 세부 정보를 확인합니다.',
	loading: '공급자 분석을 불러오는 중…',
	readFailed: '공급자 분석을 불러오지 못했습니다.',
	filters: '공급자 필터',
	table: '공급자 사용량 표',
	noData: '이 기간에는 공급자 사용량이 없습니다.',
	loadingModels: '모델을 불러오는 중…',
	noModels: '이 공급자에는 모델 사용량이 없습니다.',
	detailFailed: '모델 사용량을 불러오지 못했습니다.',
	provider_name: '공급자',
	model_id: '모델',
	route_group: '라우트 그룹',
	logsUnfilteredTag:
		'요청 로그는 태그 필터를 지원하지 않습니다. 링크된 로그에 다른 태그가 포함될 수 있습니다.',
	modelLogs: '{{model}}의 요청 로그 열기',
}

export const adminProviderAnalyticsMessages = { en, zh, ja, ko }
