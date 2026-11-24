/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	provider_kind: 'Provider type',
	directoryTitle: 'Current provider directory',
	directoryLoading: 'Loading provider types…',
	directoryUnavailable:
		'The current provider directory could not be loaded. Recorded usage is unchanged. In provider analytics, search currently matches only names or IDs; retry the directory or explicitly clear a selected type filter.',
	directoryReady: 'Current provider directory loaded.',
	directoryRetry: 'Retry directory',
	directoryAllKinds: 'All provider types',
	directoryClearKind: 'Clear type filter',
	directorySelectedUnavailable: 'Selected type (currently unavailable)',
	directoryFilterBlocked:
		'The selected type cannot be verified. Retry the directory or clear the type filter to show results.',
	directoryHint:
		'Types come from the current provider directory, not the type at the time of each request. Once the directory loads, provider analytics search also matches current type labels. A failed directory read does not change recorded usage or prove that a provider was deleted.',
	directoryMissing: 'Not in current directory',
	directoryVirtual: 'Virtual provider',
	kindUnclassified: 'Unclassified',
	kindCustom: 'Custom',
	kindUnknown: 'Unknown type',
	kindUnavailable: 'Type unavailable',
	kindRest: 'Gateway REST tools',
	kindMcp: 'Gateway MCP',
}
const zh: typeof en = {
	provider_kind: '供应商类型',
	directoryTitle: '当前供应商目录',
	directoryLoading: '正在加载供应商类型…',
	directoryUnavailable:
		'无法加载当前供应商目录，已记录的用量不受影响。供应商分析中的搜索此时仅匹配名称或 ID；请重试目录或主动清除已选的类型筛选。',
	directoryReady: '已加载当前供应商目录。',
	directoryRetry: '重试目录',
	directoryAllKinds: '所有供应商类型',
	directoryClearKind: '清除类型筛选',
	directorySelectedUnavailable: '已选类型（当前不可用）',
	directoryFilterBlocked:
		'无法核验已选类型。请重试目录或清除类型筛选后查看结果。',
	directoryHint:
		'类型来自当前供应商目录，不代表每次请求发生时的历史类型。目录加载成功后，供应商分析中的搜索也会匹配当前类型名称。目录读取失败不会改变已记录的用量，也不能据此认定供应商已删除。',
	directoryMissing: '不在当前目录中',
	directoryVirtual: '虚拟供应商',
	kindUnclassified: '未分类',
	kindCustom: '自定义',
	kindUnknown: '类型未知',
	kindUnavailable: '类型不可用',
	kindRest: '网关 REST 工具',
	kindMcp: '网关 MCP',
}
const ja: typeof en = {
	provider_kind: 'プロバイダーの種類',
	directoryTitle: '現在のプロバイダーディレクトリ',
	directoryLoading: 'プロバイダーの種類を読み込み中…',
	directoryUnavailable:
		'現在のプロバイダーディレクトリを読み込めませんでした。記録済みの使用量は変わりません。プロバイダー分析の検索では、現在は名前または ID のみが対象です。ディレクトリを再試行するか、選択した種類の絞り込みを解除してください。',
	directoryReady: '現在のプロバイダーディレクトリを読み込みました。',
	directoryRetry: 'ディレクトリを再試行',
	directoryAllKinds: 'すべての種類',
	directoryClearKind: '種類の絞り込みを解除',
	directorySelectedUnavailable: '選択した種類（現在利用不可）',
	directoryFilterBlocked:
		'選択した種類を確認できません。ディレクトリを再試行するか、種類の絞り込みを解除すると結果を表示できます。',
	directoryHint:
		'種類は現在のプロバイダーディレクトリに基づき、各リクエスト発生時の種類を示すものではありません。ディレクトリの読み込み後は、プロバイダー分析の検索で現在の種類名も対象になります。読み込み失敗は記録済みの使用量を変更せず、プロバイダーの削除を意味するものでもありません。',
	directoryMissing: '現在のディレクトリに存在しません',
	directoryVirtual: '仮想プロバイダー',
	kindUnclassified: '未分類',
	kindCustom: 'カスタム',
	kindUnknown: '種類不明',
	kindUnavailable: '種類を確認できません',
	kindRest: 'ゲートウェイ REST ツール',
	kindMcp: 'ゲートウェイ MCP',
}
const ko: typeof en = {
	provider_kind: '공급자 유형',
	directoryTitle: '현재 공급자 목록',
	directoryLoading: '공급자 유형을 불러오는 중…',
	directoryUnavailable:
		'현재 공급자 목록을 불러오지 못했습니다. 기록된 사용량은 변경되지 않습니다. 공급자 분석의 검색은 현재 이름 또는 ID만 찾습니다. 목록을 다시 불러오거나 선택한 유형 필터를 직접 지워 주세요.',
	directoryReady: '현재 공급자 목록을 불러왔습니다.',
	directoryRetry: '목록 다시 시도',
	directoryAllKinds: '모든 공급자 유형',
	directoryClearKind: '유형 필터 지우기',
	directorySelectedUnavailable: '선택한 유형(현재 확인 불가)',
	directoryFilterBlocked:
		'선택한 유형을 확인할 수 없습니다. 목록을 다시 불러오거나 유형 필터를 지우면 결과를 볼 수 있습니다.',
	directoryHint:
		'유형은 현재 공급자 목록을 기준으로 하며, 각 요청이 발생했을 때의 유형을 나타내지 않습니다. 목록을 불러온 후에는 공급자 분석의 검색에서 현재 유형 이름도 찾을 수 있습니다. 목록을 불러오지 못해도 기록된 사용량은 변경되지 않으며, 공급자가 삭제되었다고 판단할 수 없습니다.',
	directoryMissing: '현재 목록에 없음',
	directoryVirtual: '가상 공급자',
	kindUnclassified: '미분류',
	kindCustom: '사용자 지정',
	kindUnknown: '알 수 없는 유형',
	kindUnavailable: '유형 확인 불가',
	kindRest: '게이트웨이 REST 도구',
	kindMcp: '게이트웨이 MCP',
}
export const analyticsDirectoryMessages = { en, zh, ja, ko }
