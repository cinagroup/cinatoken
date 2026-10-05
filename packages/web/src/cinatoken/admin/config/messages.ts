/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const strings = {
	title: [
		'Business timezone and configuration',
		'业务时区与配置',
		'業務タイムゾーンと設定',
		'업무 시간대와 설정',
	],
	subtitle: [
		'Edit the business timezone and inspect the other global settings safely.',
		'修改业务时区，并安全查看其他全局设置状态。',
		'業務タイムゾーンを変更し、他の全体設定の状態を安全に確認します。',
		'업무 시간대를 변경하고 다른 전역 설정 상태를 안전하게 확인합니다.',
	],
	incremental: [
		'This is an incremental page. The full configuration page remains available.',
		'这是增量页面，完整配置页仍可使用。',
		'これは段階的なページです。従来の設定ページも利用できます。',
		'이 페이지는 단계적으로 제공됩니다. 전체 설정 페이지는 계속 사용할 수 있습니다.',
	],
	legacyLink: [
		'Open full configuration',
		'打开完整配置页',
		'全設定を開く',
		'전체 설정 열기',
	],
	timezone: [
		'Business timezone',
		'业务时区',
		'業務タイムゾーン',
		'업무 시간대',
	],
	timezoneHint: [
		'Use UTC or a valid IANA region or Etc zone. Existing legacy aliases remain readable but cannot be saved again.',
		'输入 UTC 或有效的 IANA 地区、Etc 时区。旧别名仍可读取，但不能再次保存。',
		'UTC または有効な IANA 地域・Etc ゾーンを入力してください。旧別名は閲覧できますが再保存できません。',
		'UTC 또는 유효한 IANA 지역·Etc 시간대를 입력하세요. 이전 별칭은 읽을 수 있지만 다시 저장할 수 없습니다.',
	],
	current: ['Current', '当前', '現在', '현재'],
	newTimezone: ['New timezone', '新时区', '新しいタイムゾーン', '새 시간대'],
	legacyTimezone: [
		'This is a legacy timezone value. Choose a valid IANA zone or UTC before saving.',
		'当前是旧版时区值；保存前请选择有效的 IANA 时区或 UTC。',
		'旧形式のタイムゾーンです。保存する前に有効な IANA ゾーンか UTC を選択してください。',
		'이전 형식의 시간대입니다. 저장하려면 유효한 IANA 시간대 또는 UTC를 선택하세요.',
	],
	saveTimezone: [
		'Save timezone',
		'保存时区',
		'タイムゾーンを保存',
		'시간대 저장',
	],
	saving: ['Saving…', '保存中…', '保存中…', '저장 중…'],
	saved: [
		'Timezone saved and current configuration reloaded.',
		'时区已保存，并已重新读取当前配置。',
		'タイムゾーンを保存し、現在の設定を再取得しました。',
		'시간대를 저장하고 현재 설정을 다시 불러왔습니다.',
	],
	readOnly: [
		'You can view this setting but cannot change it.',
		'你可以查看此设置，但无权修改。',
		'この設定は閲覧のみ可能です。',
		'이 설정은 볼 수 있지만 변경할 수 없습니다.',
	],
	otherSettings: [
		'Other global settings',
		'其他全局设置',
		'その他の全体設定',
		'기타 전역 설정',
	],
	currency: ['Billing currency', '计费币种', '請求通貨', '청구 통화'],
	strategy: [
		'Global route strategy',
		'全局路由策略',
		'全体ルート戦略',
		'전역 라우팅 전략',
	],
	wecom: [
		'WeCom error webhook',
		'企业微信错误告警 Webhook',
		'WeCom エラー Webhook',
		'WeCom 오류 웹훅',
	],
	feishu: [
		'Feishu error webhook',
		'飞书错误告警 Webhook',
		'Feishu エラー Webhook',
		'Feishu 오류 웹훅',
	],
	configured: ['Configured', '已配置', '設定済み', '설정됨'],
	notConfigured: ['Not configured', '未配置', '未設定', '설정되지 않음'],
	legacyManage: [
		'Read-only here; use the full configuration page to manage this setting.',
		'此处只读；请到完整配置页管理。',
		'ここでは閲覧のみです。管理には全設定ページを使用してください。',
		'여기서는 읽기 전용입니다. 관리하려면 전체 설정 페이지를 사용하세요.',
	],
	sourceConfigured: ['Configured', '已配置', '設定済み', '설정됨'],
	sourceLegacy: ['Legacy value', '旧版值', '旧形式の値', '이전 값'],
	sourceMissing: [
		'Default (not set)',
		'默认值（未设置）',
		'既定値（未設定）',
		'기본값(설정되지 않음)',
	],
	sourceInvalid: [
		'Default (invalid stored value)',
		'默认值（存储值无效）',
		'既定値（保存値が無効）',
		'기본값(저장된 값이 유효하지 않음)',
	],
	sourceUnsupported: [
		'Unsupported legacy currency',
		'不支持的旧币种',
		'未対応の旧通貨',
		'지원되지 않는 이전 통화',
	],
	refresh: [
		'Refresh and reconcile',
		'刷新并核对',
		'更新して照合',
		'새로 고침 및 확인',
	],
	loading: [
		'Loading configuration…',
		'正在加载配置…',
		'設定を読み込み中…',
		'설정을 불러오는 중…',
	],
	unavailable: [
		'Configuration is unavailable until the server can be verified.',
		'服务器状态确认前，配置暂不可用。',
		'サーバーの状態を確認できるまで設定を表示できません。',
		'서버 상태를 확인할 때까지 설정을 표시할 수 없습니다.',
	],
	unconfirmed: [
		'The last timezone change could not be confirmed. Refresh the server state before another save; the write will not be repeated automatically.',
		'上次时区修改结果未确认。再次保存前请刷新服务器状态；系统不会自动重发写入。',
		'前回の変更結果を確認できませんでした。再保存前にサーバー状態を更新してください。書き込みは自動再送されません。',
		'마지막 시간대 변경 결과를 확인할 수 없습니다. 다시 저장하기 전에 서버 상태를 새로 고치세요. 쓰기는 자동 재전송되지 않습니다.',
	],
	invalidTimezone: [
		'Enter a valid IANA region, Etc zone or UTC.',
		'请输入有效的 IANA 地区、Etc 时区或 UTC。',
		'有効な IANA 地域・Etc ゾーンまたは UTC を入力してください。',
		'유효한 IANA 지역·Etc 시간대 또는 UTC를 입력하세요.',
	],
	accessDenied: [
		'Console access or config permission changed. Verify access before continuing.',
		'控制台访问权限或配置权限已变化，请先重新验证。',
		'コンソールまたは設定の権限が変更されました。続行前に確認してください。',
		'콘솔 또는 설정 권한이 변경되었습니다. 계속하기 전에 권한을 확인하세요.',
	],
	invalidResponse: [
		'The configuration response could not be verified.',
		'无法验证配置响应。',
		'設定応答を確認できませんでした。',
		'설정 응답을 확인할 수 없습니다.',
	],
	conflict: [
		'The configuration changed. Refresh before saving again.',
		'配置已发生变化，请刷新后再保存。',
		'設定が変更されました。再保存前に更新してください。',
		'설정이 변경되었습니다. 다시 저장하기 전에 새로 고치세요.',
	],
	requestFailed: [
		'The request failed. Refresh the server state before trying again.',
		'请求失败。重试前请刷新服务器状态。',
		'リクエストに失敗しました。再試行前にサーバー状態を更新してください。',
		'요청에 실패했습니다. 다시 시도하기 전에 서버 상태를 새로 고치세요.',
	],
	storageUnavailable: [
		'This tab cannot retain an unconfirmed configuration change. The update was not sent; enable session storage before trying again.',
		'此标签页无法保存未确认配置变更标记。更新未发送；请启用会话存储后重试。',
		'このタブでは未確認の設定変更を保持できません。更新は送信されていません。セッションストレージを有効にしてから再試行してください。',
		'이 탭은 미확인 설정 변경을 보관할 수 없습니다. 업데이트는 전송되지 않았습니다. 세션 저장소를 활성화한 뒤 다시 시도하세요.',
	],
	storageCleanupFailed: [
		'This tab could not clear the pending marker. The setting stays locked; check the server state before continuing.',
		'此标签页无法清除未确认标记。设置仍被锁定；继续前请核对服务器状态。',
		'このタブでは未確認マーカーを消去できません。設定はロックされたままです。続行前にサーバー状態を確認してください。',
		'이 탭에서 미확인 표시를 지울 수 없습니다. 설정은 계속 잠겨 있습니다. 계속하기 전에 서버 상태를 확인하세요.',
	],
} satisfies Record<string, readonly [string, string, string, string]>

function language(index: number): Record<string, string> {
	return Object.fromEntries(
		Object.entries(strings).map(([key, values]) => [key, values[index]!])
	)
}

export const configTimezoneMessages = {
	en: language(0),
	zh: language(1),
	ja: language(2),
	ko: language(3),
}

const fullStrings = {
	title: ['Global configuration', '全局配置', '全体設定', '전역 설정'],
	subtitle: [
		'Manage the business timezone, billing currency, route strategy and error webhooks.',
		'管理业务时区、计费币种、路由策略和错误告警 Webhook。',
		'業務タイムゾーン、請求通貨、ルート戦略、エラー通知 Webhook を管理します。',
		'업무 시간대, 결제 통화, 라우팅 전략 및 오류 웹훅을 관리합니다.',
	],
	saveCurrency: ['Save currency', '保存币种', '通貨を保存', '통화 저장'],
	saveStrategy: ['Save strategy', '保存策略', '戦略を保存', '전략 저장'],
	selectCurrency: ['New currency', '新币种', '新しい通貨', '새 통화'],
	selectStrategy: [
		'New route strategy',
		'新路由策略',
		'新しいルート戦略',
		'새 라우팅 전략',
	],
	currencyWarning: [
		'Changing the billing currency does not convert existing price or budget numbers. Review those values separately.',
		'切换计费币种不会自动换算现有价格或预算数值；请另行核对这些数值。',
		'請求通貨を変更しても既存の価格や予算の数値は自動換算されません。別途確認してください。',
		'결제 통화를 변경해도 기존 가격이나 예산 수치는 자동 환산되지 않습니다. 별도로 확인하세요.',
	],
	strategyHash: ['Hash affinity', '哈希亲和', 'ハッシュ親和性', '해시 선호'],
	strategyRandom: [
		'Weighted random',
		'加权随机',
		'重み付きランダム',
		'가중 무작위',
	],
	strategyPriority: ['Weight priority', '权重优先', '重み優先', '가중치 우선'],
	strategyRoundRobin: [
		'Weighted round robin',
		'加权轮询',
		'重み付きラウンドロビン',
		'가중 라운드 로빈',
	],
	webhookHintWecom: [
		'Use an HTTPS URL on qyapi.weixin.qq.com. The existing URL remains hidden until you explicitly reveal it.',
		'请输入 qyapi.weixin.qq.com 上的 HTTPS URL。现有 URL 仅在明确揭示后显示。',
		'詳細 URL は明示的に表示するまで隠されます。qyapi.weixin.qq.com の HTTPS URL を使用してください。',
		'기존 URL은 명시적으로 표시할 때까지 숨겨집니다. qyapi.weixin.qq.com의 HTTPS URL을 사용하세요.',
	],
	webhookHintFeishu: [
		'Use an HTTPS URL on open.feishu.cn. The existing URL remains hidden until you explicitly reveal it.',
		'请输入 open.feishu.cn 上的 HTTPS URL。现有 URL 仅在明确揭示后显示。',
		'詳細 URL は明示的に表示するまで隠されます。open.feishu.cn の HTTPS URL を使用してください。',
		'기존 URL은 명시적으로 표시할 때까지 숨겨집니다. open.feishu.cn の HTTPS URL を使用してください。',
	],
	replace: ['Replace URL', '替换 URL', 'URL を置換', 'URL 교체'],
	clear: ['Clear URL', '清除 URL', 'URL を削除', 'URL 지우기'],
	reveal: [
		'Reveal current URL',
		'揭示当前 URL',
		'現在の URL を表示',
		'현재 URL 표시',
	],
	hide: [
		'Hide and forget URL',
		'隐藏并清除 URL',
		'URL を隠して破棄',
		'URL 숨기고 지우기',
	],
	revealed: [
		'Current URL, visible only until hidden or leaving this page',
		'当前 URL；隐藏或离开页面后即清除',
		'現在の URL。隠すかページを離れると破棄します',
		'현재 URL입니다. 숨기거나 페이지를 떠나면 지워집니다',
	],
	newWebhook: [
		'New webhook URL',
		'新 Webhook URL',
		'新しい Webhook URL',
		'새 웹훅 URL',
	],
	closeEditor: ['Close editor', '关闭编辑', '編集を閉じる', '편집 닫기'],
	confirmTitle: [
		'Confirm configuration change',
		'确认配置变更',
		'設定変更を確認',
		'설정 변경 확인',
	],
	confirmChange: ['Confirm change', '确认变更', '変更を確認', '변경 확인'],
	cancel: ['Cancel', '取消', 'キャンセル', '취소'],
	confirmReplace: [
		'Replace this webhook URL? The old URL will stop receiving alerts.',
		'确定替换此 Webhook URL？旧 URL 将不再接收告警。',
		'この Webhook URL を置換しますか。旧 URL への通知は停止します。',
		'이 웹훅 URL을 교체할까요? 기존 URL에는 더 이상 알림이 전송되지 않습니다.',
	],
	confirmClear: [
		'Clear this webhook URL? Alerts for this channel will stop.',
		'确定清除此 Webhook URL？此渠道的告警将停止。',
		'この Webhook URL を削除しますか。このチャネルの通知は停止します。',
		'이 웹훅 URL을 지울까요? 이 채널의 알림이 중단됩니다.',
	],
	confirmCurrency: [
		'Confirm the billing currency change. Existing price and budget numbers will not be converted.',
		'确认切换计费币种。现有价格与预算数值不会自动换算。',
		'請求通貨の変更を確認してください。既存の価格と予算の数値は換算されません。',
		'결제 통화 변경을 확인하세요. 기존 가격과 예산 수치는 환산되지 않습니다.',
	],
	confirmOther: [
		'Apply this configuration change?',
		'确定应用此配置变更？',
		'この設定変更を適用しますか。',
		'이 설정 변경을 적용할까요?',
	],
	targetValue: [
		'Target value: {{value}}',
		'目标值：{{value}}',
		'変更先：{{value}}',
		'대상 값: {{value}}',
	],
	saved: [
		'Change confirmed and current configuration reloaded.',
		'变更已确认，当前配置已重新读取。',
		'変更を確認し、現在の設定を再取得しました。',
		'변경이 확인되었고 현재 설정을 다시 불러왔습니다.',
	],
	readOnly: [
		'You may view configuration but cannot change it.',
		'你可以查看配置，但无权修改。',
		'設定を閲覧できますが変更権限はありません。',
		'설정을 볼 수 있지만 변경할 수 없습니다.',
	],
	unconfirmed: [
		'A write result is unknown. This setting is locked until the current server state is explicitly checked. It will not be sent again automatically.',
		'写入结果未知。明确核对服务器当前状态前，此设置已锁定；系统不会自动重发。',
		'書き込み結果は不明です。サーバーの現在状態を明示的に確認するまで、この設定をロックし、自動再送しません。',
		'쓰기 결과를 알 수 없습니다. 서버의 현재 상태를 명시적으로 확인할 때까지 이 설정은 잠기며 자동 재전송되지 않습니다.',
	],
	refreshed: [
		'Current server configuration reloaded.',
		'已重新读取服务器当前配置。',
		'現在のサーバー設定を再取得しました。',
		'현재 서버 설정을 다시 불러왔습니다.',
	],
	refreshPending: [
		'Current status reloaded, but the webhook replacement is still unconfirmed. Verify the exact URL before another change.',
		'已重新读取当前状态，但 Webhook 替换结果仍未确认。再次修改前请核对精确 URL。',
		'現在の状態を再取得しましたが、Webhook の置換結果は未確認です。次の変更前に正確な URL を照合してください。',
		'현재 상태를 다시 불러왔지만 웹훅 교체 결과는 아직 미확인입니다. 다음 변경 전에 정확한 URL을 확인하세요.',
	],
	verifyWebhook: [
		'Verify submitted URL',
		'核对刚提交的 URL',
		'送信した URL を照合',
		'제출한 URL 확인',
	],
	verifyHint: [
		'A configured status alone cannot confirm which URL was saved. Verify the submitted URL explicitly.',
		'“已配置”不能证明保存的是哪个 URL；请明确核对刚提交的 URL。',
		'設定済みという状態だけでは保存された URL を確認できません。送信した URL を明示的に照合してください。',
		'설정됨 상태만으로 저장된 URL을 확인할 수 없습니다. 제출한 URL을 명시적으로 확인하세요.',
	],
	verifyUnavailable: [
		'The submitted URL is no longer available in this page, or you lack reveal permission. This result remains unconfirmed; ask a privileged administrator to verify it.',
		'刚提交的 URL 已从本页内存清除，或你没有揭示权限。结果仍未确认；请让有权限的管理员核对。',
		'送信した URL がこのページに残っていないか、表示権限がありません。結果は未確認のままです。権限のある管理者に確認を依頼してください。',
		'제출한 URL이 이 페이지에 남아 있지 않거나 표시 권한이 없습니다. 결과는 미확인 상태이며 권한 있는 관리자에게 확인을 요청하세요.',
	],
	reviewCurrentHint: [
		'After refreshing, reveal and compare the current URL with your own record. If no URL is configured, review that empty state. Only then acknowledge the current state.',
		'刷新后，请揭示当前 URL 并与自己的记录核对；若未配置 URL，请核对空状态。完成后再确认当前状态。',
		'更新後、現在の URL を表示し、ご自身の記録と照合してください。未設定なら空の状態を確認してから、現在の状態を承認してください。',
		'새로 고친 후 현재 URL을 표시하여 보유한 기록과 비교하세요. URL이 없으면 빈 상태를 확인한 뒤 현재 상태를 승인하세요.',
	],
	reviewCurrent: [
		'Review current state',
		'核对当前状态',
		'現在の状態を確認',
		'현재 상태 확인',
	],
	reviewCurrentConfirm: [
		'Confirm that you checked the current server state. This releases the pending lock; it does not confirm that the earlier replacement succeeded.',
		'请确认你已核对服务器当前状态。此操作解除未确认锁，但不代表先前的替换已成功。',
		'現在のサーバー状態を確認したことを承認してください。未確認のロックは解除されますが、先の置換が成功したことは意味しません。',
		'현재 서버 상태를 확인했음을 승인하세요. 미확인 잠금은 해제되지만 이전 교체가 성공했다는 뜻은 아닙니다.',
	],
	acceptCurrent: [
		'Acknowledge current state',
		'确认当前状态',
		'現在の状態を承認',
		'현재 상태 승인',
	],
	currentReviewed: [
		'Current server state acknowledged. The earlier replacement result remains unknown.',
		'已确认服务器当前状态；先前替换的结果仍未知。',
		'現在のサーバー状態を承認しました。先の置換結果は不明のままです。',
		'현재 서버 상태를 승인했습니다. 이전 교체 결과는 여전히 알 수 없습니다.',
	],
	currentMatches: [
		'The current server value matches the submitted value. This does not establish which request wrote it.',
		'服务器当前值与提交值一致，但这不表示能确定由哪次请求写入。',
		'現在のサーバー値は送信値と一致しますが、どのリクエストが書き込んだかは特定しません。',
		'현재 서버 값이 제출한 값과 일치하지만 어떤 요청이 기록했는지는 확인할 수 없습니다.',
	],
	currentDiffers: [
		'The current server value differs from the submitted value. Review it before a new explicit change.',
		'服务器当前值与提交值不同；请核对后再明确发起新变更。',
		'現在のサーバー値は送信値と異なります。新たな変更前に確認してください。',
		'현재 서버 값이 제출한 값과 다릅니다. 새 변경 전에 확인하세요.',
	],
	invalidWebhook: [
		'Enter a channel-specific HTTPS webhook URL without credentials, custom port or fragment.',
		'请输入对应渠道官方域名上的 HTTPS URL，不含凭据、自定义端口或片段。',
		'該当チャネルの公式ドメインの HTTPS URL を入力してください。認証情報、独自ポート、フラグメントは使用できません。',
		'해당 채널 공식 도메인의 HTTPS URL을 입력하세요. 자격 증명, 사용자 지정 포트 또는 조각은 허용되지 않습니다.',
	],
	invalidSetting: [
		'The setting was rejected. Check its value and refresh before trying again.',
		'配置值被拒绝；请检查后刷新再试。',
		'設定値が拒否されました。確認してから更新し、再試行してください。',
		'설정 값이 거부되었습니다. 확인하고 새로 고친 뒤 다시 시도하세요.',
	],
	invalidTimezone: [
		'Enter a valid IANA region, Etc zone or UTC.',
		'请输入有效的 IANA 地区、Etc 时区或 UTC。',
		'有効な IANA 地域・Etc ゾーンまたは UTC を入力してください。',
		'유효한 IANA 지역·Etc 시간대 또는 UTC를 입력하세요.',
	],
	accessDenied: [
		'Console access or configuration permission changed. Verify access before continuing.',
		'控制台访问或配置权限已变化；继续前请重新验证。',
		'コンソールまたは設定の権限が変更されました。続行前に確認してください。',
		'콘솔 또는 설정 권한이 변경되었습니다. 계속하기 전에 확인하세요.',
	],
	invalidResponse: [
		'The configuration response could not be verified.',
		'无法验证配置响应。',
		'設定応答を確認できませんでした。',
		'설정 응답을 확인할 수 없습니다.',
	],
	conflict: [
		'The configuration changed. Refresh before saving again.',
		'配置已发生变化；请刷新后再保存。',
		'設定が変更されました。再保存前に更新してください。',
		'설정이 변경되었습니다. 다시 저장하기 전에 새로 고치세요.',
	],
	requestFailed: [
		'The request failed. Refresh the server state before trying again.',
		'请求失败。重试前请刷新服务器状态。',
		'リクエストに失敗しました。再試行前にサーバー状態を更新してください。',
		'요청에 실패했습니다. 다시 시도하기 전에 서버 상태를 새로 고치세요.',
	],
} satisfies Record<string, readonly [string, string, string, string]>

function fullLanguage(
	index: number,
	base: Record<string, string>
): Record<string, string> {
	return {
		...base,
		...Object.fromEntries(
			Object.entries(fullStrings).map(([key, values]) => [key, values[index]!])
		),
	}
}

export const configFullMessages = {
	en: fullLanguage(0, configTimezoneMessages.en),
	zh: fullLanguage(1, configTimezoneMessages.zh),
	ja: fullLanguage(2, configTimezoneMessages.ja),
	ko: fullLanguage(3, configTimezoneMessages.ko),
}
