const en = {
	title: 'Workspace budgets',
	subtitle:
		'Limits apply to all eligible usage in this workspace. Account and API-key limits may also apply.',
	editable: 'Can manage',
	readOnly: 'Read only',
	loading: 'Loading workspace budgets…',
	loadFailed: 'Could not load workspace budgets.',
	denied: 'Your current access does not allow changing these budgets.',
	notConfigured: 'Not configured',
	limit: 'Limit',
	spent: 'Spent',
	reserved: 'Reserved',
	remaining: 'Remaining',
	period: '{{start}} – {{end}} (UTC)',
	since: 'Since {{start}} (UTC)',
	limitLabel: '{{interval}} limit ({{currency}})',
	save: 'Save limit',
	saving: 'Saving…',
	remove: 'Remove limit',
	removeTitle: 'Remove the {{interval}} budget?',
	removeNotice:
		'This workspace limit will no longer apply. Account and API-key limits remain in effect.',
	saved: 'Workspace budget saved.',
	removed: 'Workspace budget removed.',
	invalid:
		'Enter a positive amount that rounds to at least one micro-unit and stays within the supported range.',
	failed:
		'The change could not be confirmed. Refresh the budgets before trying again.',
	ordering:
		'Configured limits must increase from daily to weekly, monthly and lifetime. Use a decimal point for amounts.',
	rejected:
		'The server rejected this limit. Check its amount and the order of configured limits.',
	usage: '{{interval}} spent and reserved usage',
	intervals: {
		daily: 'Daily',
		weekly: 'Weekly',
		monthly: 'Monthly',
		lifetime: 'Lifetime',
	},
}
const zh: typeof en = {
	title: '工作区预算',
	subtitle:
		'限制适用于此工作区内的所有相关用量。账户与 API 密钥预算也可能同时生效。',
	editable: '可管理',
	readOnly: '只读',
	loading: '正在加载工作区预算…',
	loadFailed: '无法加载工作区预算。',
	denied: '当前权限不允许修改这些预算。',
	notConfigured: '未配置',
	limit: '限额',
	spent: '已消费',
	reserved: '已预留',
	remaining: '剩余',
	period: '{{start}} 至 {{end}}（UTC）',
	since: '自 {{start}} 起（UTC）',
	limitLabel: '{{interval}}限额（{{currency}}）',
	save: '保存限额',
	saving: '正在保存…',
	remove: '移除限额',
	removeTitle: '移除{{interval}}预算？',
	removeNotice: '此工作区限额将不再生效。账户与 API 密钥限额仍然有效。',
	saved: '工作区预算已保存。',
	removed: '工作区预算已移除。',
	invalid: '请输入正数金额，四舍五入后至少为一个微单位，且不超过支持范围。',
	failed: '无法确认变更结果。请先刷新预算，再决定是否重试。',
	ordering:
		'已配置限额必须按每日、每周、每月、累计的顺序递增。金额使用小数点。',
	rejected: '服务端拒绝了此限额。请检查金额及已配置限额的递增顺序。',
	usage: '{{interval}}已消费与预留用量',
	intervals: {
		daily: '每日',
		weekly: '每周',
		monthly: '每月',
		lifetime: '累计',
	},
}
const ja: typeof en = {
	title: 'ワークスペース予算',
	subtitle:
		'このワークスペースの対象使用量全体に適用されます。アカウントや API キーの制限も適用される場合があります。',
	editable: '管理可能',
	readOnly: '閲覧のみ',
	loading: '予算を読み込み中…',
	loadFailed: 'ワークスペース予算を読み込めませんでした。',
	denied: '現在の権限では予算を変更できません。',
	notConfigured: '未設定',
	limit: '上限',
	spent: '使用済み',
	reserved: '予約済み',
	remaining: '残額',
	period: '{{start}} ～ {{end}}（UTC）',
	since: '{{start}} 以降（UTC）',
	limitLabel: '{{interval}}の上限（{{currency}}）',
	save: '上限を保存',
	saving: '保存中…',
	remove: '上限を削除',
	removeTitle: '{{interval}}の予算を削除しますか？',
	removeNotice:
		'このワークスペース上限は適用されなくなります。アカウントと API キーの上限は引き続き適用されます。',
	saved: '予算を保存しました。',
	removed: '予算を削除しました。',
	invalid:
		'丸めた後に少なくとも一マイクロ単位となる、対応範囲内の正の金額を入力してください。',
	failed: '変更を確認できませんでした。再試行前に予算を更新してください。',
	ordering:
		'設定済みの上限は日次、週次、月次、累計の順に増やしてください。金額には小数点を使用します。',
	rejected:
		'上限が拒否されました。金額と設定済み上限の順序を確認してください。',
	usage: '{{interval}}の使用済みと予約済み使用量',
	intervals: {
		daily: '日次',
		weekly: '週次',
		monthly: '月次',
		lifetime: '累計',
	},
}
const ko: typeof en = {
	title: '워크스페이스 예산',
	subtitle:
		'이 워크스페이스의 해당 사용량 전체에 적용됩니다. 계정 및 API 키 한도도 적용될 수 있습니다.',
	editable: '관리 가능',
	readOnly: '읽기 전용',
	loading: '예산 불러오는 중…',
	loadFailed: '워크스페이스 예산을 불러오지 못했습니다.',
	denied: '현재 권한으로 이 예산을 변경할 수 없습니다.',
	notConfigured: '미설정',
	limit: '한도',
	spent: '사용액',
	reserved: '예약액',
	remaining: '잔액',
	period: '{{start}} – {{end}} (UTC)',
	since: '{{start}}부터 (UTC)',
	limitLabel: '{{interval}} 한도 ({{currency}})',
	save: '한도 저장',
	saving: '저장 중…',
	remove: '한도 삭제',
	removeTitle: '{{interval}} 예산을 삭제할까요?',
	removeNotice:
		'이 워크스페이스 한도가 더 이상 적용되지 않습니다. 계정 및 API 키 한도는 계속 적용됩니다.',
	saved: '워크스페이스 예산이 저장되었습니다.',
	removed: '워크스페이스 예산이 삭제되었습니다.',
	invalid:
		'반올림 후 최소 한 마이크로 단위가 되는 지원 범위 내의 양수 금액을 입력하세요.',
	failed:
		'변경을 확인하지 못했습니다. 다시 시도하기 전에 예산을 새로 고침하세요.',
	ordering:
		'설정된 한도는 일일, 주간, 월간, 누적 순서로 증가해야 합니다. 금액에는 소수점을 사용하세요.',
	rejected:
		'서버가 한도를 거부했습니다. 금액과 설정된 한도의 순서를 확인하세요.',
	usage: '{{interval}} 사용 및 예약 사용량',
	intervals: {
		daily: '일일',
		weekly: '주간',
		monthly: '월간',
		lifetime: '누적',
	},
}
export const workspaceBudgetMessages = { en, zh, ja, ko }
