/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const strings = {
	syncRecalculated: [
		'The server recalculates official values on apply. Reload the comparison if they may have changed.',
		'服务端在应用时重新计算官方值；如值可能有变，请重新获取差异。',
		'適用時にサーバーが公式値を再計算します。変更の可能性があれば差分を再取得してください。',
		'적용 시 서버가 공식 값을 다시 계산합니다. 변경되었을 가능성이 있으면 차이를 다시 조회하세요.',
	],
	kind: ['Provider type', '供应商类型', 'プロバイダー種別', '공급자 유형'],
	kindCustom: [
		'Custom provider',
		'自定义供应商',
		'カスタムプロバイダー',
		'사용자 지정 공급자',
	],
	kindHint: [
		'Type controls official synchronization and quota support. Changing it keeps your credentials and endpoints.',
		'类型决定官方同步与额度查询能力；更改类型会保留凭据和端点。',
		'種別は公式同期と残高照会の対応を決めます。変更しても認証情報とエンドポイントは保持されます。',
		'유형은 공식 동기화 및 잔액 조회 지원을 결정합니다. 변경해도 인증 정보와 엔드포인트는 유지됩니다.',
	],
	sync: [
		'Review official changes',
		'核对官方变更',
		'公式の変更を確認',
		'공식 변경 검토',
	],
	syncHint: [
		'Select fields to replace with the current official template. Endpoint selections replace the entire selected protocol; review custom settings before applying.',
		'选择要采用官方值的字段。端点按所选协议整体替换，请先核对自定义设置。',
		'公式テンプレートで置き換える項目を選択します。選択したプロトコルのエンドポイント全体が置き換わるため、独自設定を確認してください。',
		'공식 값으로 바꿀 필드를 선택하세요. 선택한 프로토콜의 엔드포인트 전체가 교체되므로 사용자 설정을 먼저 확인하세요.',
	],
	syncEmpty: [
		'No official changes.',
		'没有官方变更。',
		'公式の変更はありません。',
		'공식 변경 사항이 없습니다.',
	],
	current: ['Current', '当前值', '現在の値', '현재 값'],
	official: ['Official', '官方值', '公式の値', '공식 값'],
	added: ['Added', '新增', '追加', '추가'],
	changed: ['Changed', '变更', '変更', '변경'],
	removed: ['Removed', '移除', '削除', '제거'],
	syncConfirm: [
		'I reviewed the selected replacements.',
		'我已核对所选替换项。',
		'選択した置換内容を確認しました。',
		'선택한 교체 내용을 확인했습니다.',
	],
	syncApply: [
		'Apply selected fields',
		'应用所选字段',
		'選択した項目を適用',
		'선택한 필드 적용',
	],
	syncResult: [
		'Updated {{updated}}, unchanged {{skipped}}, failed {{failed}}.',
		'已更新 {{updated}} 项，未变 {{skipped}} 项，失败 {{failed}} 项。',
		'更新 {{updated}}、変更なし {{skipped}}、失敗 {{failed}}。',
		'업데이트 {{updated}}개, 변경 없음 {{skipped}}개, 실패 {{failed}}개.',
	],
	syncFailedItem: [
		'{{id}}: Not completed; changes may have been partially applied. Verify the current state before checking differences again.',
		'{{id}}：未完成，可能已部分应用。请核查当前状态后再检查差异。',
		'{{id}}: 完了していません。一部の変更が適用されている可能性があります。現在の状態を確認してから差分を再確認してください。',
		'{{id}}: 완료되지 않았으며 일부 변경이 적용되었을 수 있습니다. 현재 상태를 확인한 후 차이를 다시 확인하세요.',
	],
	syncRecheck: [
		'Load a fresh comparison',
		'重新获取差异',
		'差分を再取得',
		'차이 다시 조회',
	],
	syncOrphans: [
		'Types missing from the official catalog',
		'官方目录中缺失的类型',
		'公式カタログに存在しない種別',
		'공식 카탈로그에 없는 유형',
	],
	syncMigrate: [
		'Change provider type',
		'更改供应商类型',
		'プロバイダー種別を変更',
		'공급자 유형 변경',
	],
	syncMigrateHint: [
		'Suggested types are hints. Choose explicitly; only the type will change.',
		'建议类型仅供参考，请明确选择；此操作仅修改类型。',
		'推奨種別は参考情報です。明示的に選択してください。種別のみを変更します。',
		'추천 유형은 참고용입니다. 직접 선택하세요. 유형만 변경됩니다.',
	],
	syncMigrated: [
		'Provider type updated. Reload the comparison to review official fields.',
		'供应商类型已更新，请重新获取差异以核对官方字段。',
		'種別を更新しました。差分を再取得して公式項目を確認してください。',
		'공급자 유형을 변경했습니다. 차이를 다시 조회하여 공식 필드를 확인하세요.',
	],
	syncSuggested: [
		'Suggested: {{kind}}',
		'建议：{{kind}}',
		'推奨: {{kind}}',
		'추천: {{kind}}',
	],
	quota: ['Provider quota', '供应商额度', 'プロバイダー残高', '공급자 잔액'],
	quotaQuery: ['Query quota', '查询额度', '残高を照会', '잔액 조회'],
	quotaHint: [
		'Queries the provider on demand using its stored credential. Values keep the provider’s original currency and units.',
		'按需使用已存凭据查询供应商；金额和单位按供应商原样显示。',
		'保存済み認証情報で必要時に照会します。通貨と単位はプロバイダーの値です。',
		'저장된 인증 정보로 요청 시 조회합니다. 공급자의 원래 통화와 단위를 표시합니다.',
	],
	quotaChecked: ['Checked at', '查询时间', '照会日時', '조회 시각'],
	quotaState_ok: ['Available', '可用', '利用可能', '사용 가능'],
	quotaState_low: ['Running low', '即将耗尽', '残りわずか', '부족'],
	quotaState_exhausted: ['Exhausted', '已耗尽', '使い切り', '소진됨'],
	quotaState_unknown: ['Unknown', '未知', '不明', '알 수 없음'],
	quotaBalance: ['Balance', '余额', '残高', '잔액'],
	quotaGranted: ['Granted', '赠送余额', '付与分', '지급 잔액'],
	quotaPaid: ['Paid', '付费余额', '購入分', '유료 잔액'],
	quotaWindow: ['Window', '窗口', '期間', '기간'],
	quotaUsed: ['Used', '已用', '使用済み', '사용량'],
	quotaLimit: ['Limit', '上限', '上限', '한도'],
	quotaRemaining: ['Remaining', '剩余', '残り', '남은 양'],
	quotaReset: ['Resets at', '重置时间', 'リセット日時', '초기화 시각'],
	quotaUnit: ['Unit', '单位', '単位', '단위'],
} satisfies Record<string, readonly [string, string, string, string]>
export function providerCompatibilityMessages(
	index: 0 | 1 | 2 | 3
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(strings).map(([key, values]) => [key, values[index]])
	)
}
