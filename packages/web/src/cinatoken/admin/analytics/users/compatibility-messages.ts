/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	wallet_granted: 'Wallet granted (max)',
	wallet_spent: 'Wallet spent (max)',
	wallet_balance: 'Wallet balance (one account)',
	walletScope:
		'Wallet granted/spent are current joined-account maxima for each log email, not range spend. Balance and Key drilldown require a single existing account for every request in that email group. Missing values remain unavailable.',
	viewKeys: 'Key usage',
	keysUnavailable: 'Account identity unavailable for this email group.',
	keysTitle: 'Keys for {{email}}',
	keyScope:
		'Key usage covers this account across all logged emails in the selected range. Unused current Keys show zero usage. Deleted-Key history has no per-Key link.',
	loadingKeys: 'Loading Key usage…',
	keysFailed: 'Key usage could not be loaded.',
	noKeys: 'No Keys or historical Key usage for this account.',
	noKeyModels: 'No model usage for this Key in the selected range.',
	key_name: 'Key name',
	api_key_id: 'Key ID',
	keyModels: 'Model usage for key {{name}}',
	keyLogs: 'Request logs for key {{name}}',
	unnamedKey: 'Unnamed Key',
	deletedKey: 'Deleted-Key history',
	keyOutcomes: 'Success {{success}} · Errors {{errors}} · Other {{other}}',
}
const zh: typeof en = {
	wallet_granted: '永久额度累计授予（最大值）',
	wallet_spent: '永久额度累计消费（最大值）',
	wallet_balance: '永久额度余额（单一账号）',
	walletScope:
		'永久额度累计授予与消费是按日志邮箱关联账号的当前最大值，并非所选时段支出。只有该邮箱组的每条请求都属于同一现存账号，才提供余额和 Key 下钻；缺失值显示不可用。',
	viewKeys: 'Key 用量',
	keysUnavailable: '此邮箱组的账号身份不可用。',
	keysTitle: '{{email}} 的 Key',
	keyScope:
		'Key 用量覆盖此账号在所选时段内的全部日志邮箱。未使用的现有 Key 显示零用量；已删除 Key 的历史不提供单 Key 链接。',
	loadingKeys: '正在加载 Key 用量…',
	keysFailed: '无法加载 Key 用量。',
	noKeys: '此账号没有 Key 或历史 Key 用量。',
	noKeyModels: '所选时段内此 Key 没有模型用量。',
	key_name: 'Key 名称',
	api_key_id: 'Key ID',
	keyModels: '查看 Key {{name}} 的模型用量',
	keyLogs: '查看 Key {{name}} 的请求日志',
	unnamedKey: '未命名 Key',
	deletedKey: '已删除 Key 的历史',
	keyOutcomes: '成功 {{success}} · 错误 {{errors}} · 其他 {{other}}',
}
const ja: typeof en = {
	wallet_granted: '永久クレジット付与累計（最大値）',
	wallet_spent: '永久クレジット利用累計（最大値）',
	wallet_balance: '永久クレジット残高（単一アカウント）',
	walletScope:
		'付与・利用累計はログのメールアドレスに関連付くアカウントの現在の最大値で、選択期間の支出ではありません。全リクエストが同一の現存アカウントに属する場合のみ残高と Key 内訳を表示します。不明な値は利用不可と表示します。',
	viewKeys: 'Key 使用量',
	keysUnavailable: 'このメールグループのアカウントを特定できません。',
	keysTitle: '{{email}} の Key',
	keyScope:
		'Key 使用量は、選択期間におけるこのアカウントの全ログメールを対象とします。未使用の現行 Key は使用量ゼロ、削除済み Key の履歴には個別リンクがありません。',
	loadingKeys: 'Key 使用量を読み込み中…',
	keysFailed: 'Key 使用量を読み込めませんでした。',
	noKeys: 'このアカウントには Key または使用履歴がありません。',
	noKeyModels: '選択期間中、この Key のモデル使用量はありません。',
	key_name: 'Key 名',
	api_key_id: 'Key ID',
	keyModels: 'Key {{name}} のモデル使用量',
	keyLogs: 'Key {{name}} のリクエストログ',
	unnamedKey: '名前のない Key',
	deletedKey: '削除済み Key の履歴',
	keyOutcomes: '成功 {{success}} · エラー {{errors}} · その他 {{other}}',
}
const ko: typeof en = {
	wallet_granted: '영구 크레딧 지급 누계 (최댓값)',
	wallet_spent: '영구 크레딧 사용 누계 (최댓값)',
	wallet_balance: '영구 크레딧 잔액 (단일 계정)',
	walletScope:
		'지급 및 사용 누계는 로그 이메일에 연결된 계정의 현재 최댓값이며 선택 기간의 지출이 아닙니다. 모든 요청이 동일한 기존 계정에 속하는 경우에만 잔액과 Key 상세를 제공합니다. 누락된 값은 사용할 수 없음으로 표시합니다.',
	viewKeys: 'Key 사용량',
	keysUnavailable: '이 이메일 그룹의 계정 식별 정보를 사용할 수 없습니다.',
	keysTitle: '{{email}}의 Key',
	keyScope:
		'Key 사용량은 선택 기간 동안 이 계정의 모든 로그 이메일을 포함합니다. 미사용 현재 Key는 사용량 0으로 표시하며 삭제된 Key 기록에는 개별 링크가 없습니다.',
	loadingKeys: 'Key 사용량을 불러오는 중…',
	keysFailed: 'Key 사용량을 불러오지 못했습니다.',
	noKeys: '이 계정에 Key 또는 사용 기록이 없습니다.',
	noKeyModels: '선택 기간에 이 Key의 모델 사용량이 없습니다.',
	key_name: 'Key 이름',
	api_key_id: 'Key ID',
	keyModels: 'Key {{name}}의 모델 사용량',
	keyLogs: 'Key {{name}}의 요청 로그',
	unnamedKey: '이름 없는 Key',
	deletedKey: '삭제된 Key 기록',
	keyOutcomes: '성공 {{success}} · 오류 {{errors}} · 기타 {{other}}',
}
export const userAnalyticsCompatibilityMessages = { en, zh, ja, ko }
