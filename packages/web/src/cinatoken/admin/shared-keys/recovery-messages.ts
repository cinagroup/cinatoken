/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	recoverGovernance: 'Review unknown governance result',
	recoverReview: 'Review unknown review result',
	recoveryInspect: 'Read current state',
	recoveryAck:
		'I understand the earlier result is still unknown. Discard its draft and allow a new review.',
	recoveryConfirm: 'Allow a new review',
	recoveryUnavailable:
		'This legacy or invalid safety marker cannot be linked to an operation. Changes remain locked.',
	recoveryMissing:
		'This key is currently absent. Its earlier result is still unknown. Only other existing keys can be reviewed.',
	recoveryRevision: 'Current revision',
	recoveryHint:
		'Read the exact key and its audit records with your verified identity. Current evidence does not prove the outcome of the earlier operation. No operation will be replayed.',
	reviewRecoveryHint:
		'Discover current candidates for the same UTC range. The earlier review result remains unknown. Review requests do not change balances or queue payments. Nothing will be replayed.',
	recoveryAuditScope:
		'Only the displayed audit page has been read. Empty records do not prove the earlier result.',
	recoveryFailed:
		'Current evidence or verified identity could not be read. The safety lock remains.',
}
type Messages = Record<keyof typeof en, string>
const zh: Messages = {
	recoverGovernance: '核对结果未知的治理操作',
	recoverReview: '核对结果未知的收益审核',
	recoveryInspect: '读取当前状态',
	recoveryAck: '我理解此前的结果仍未知。同意丢弃旧草稿，并开始新的审阅。',
	recoveryConfirm: '允许新的审阅',
	recoveryUnavailable: '旧版或无效安全标记无法关联到具体操作，变更仍被锁定。',
	recoveryMissing:
		'该 Key 当前不存在，此前的操作结果仍未知。只能重新审阅其他现存 Key。',
	recoveryRevision: '当前版本',
	recoveryHint:
		'以已验证身份读取该 Key 的精确详情及审计记录。当前证据不能证明此前操作的结果，也不会重放任何操作。',
	reviewRecoveryHint:
		'重新发现同一 UTC 范围内的当前候选。此前的审核结果仍未知；审核请求不改变余额或排队付款，也不会重放此前请求。',
	recoveryAuditScope:
		'仅已读取当前展示的审计页。空记录不能证明此前操作的结果。',
	recoveryFailed: '无法读取当前证据或核验身份，安全锁仍保留。',
}
const ja: Messages = {
	recoverGovernance: '結果不明の管理操作を確認',
	recoverReview: '結果不明の収益審査を確認',
	recoveryInspect: '現在の状態を読む',
	recoveryAck:
		'以前の結果は依然として不明であることを理解し、下書きを破棄して新しい確認を始めます。',
	recoveryConfirm: '新しい確認を許可',
	recoveryUnavailable:
		'古い形式または無効な安全記録を操作に関連付けられないため、変更はロックされたままです。',
	recoveryMissing:
		'このキーは現在存在せず、以前の結果は依然として不明です。他の既存キーのみ新しく確認できます。',
	recoveryRevision: '現在のリビジョン',
	recoveryHint:
		'検証済みの本人として対象キーの詳細と監査記録を読みます。現在の証拠は以前の結果を証明せず、操作の再実行もしません。',
	reviewRecoveryHint:
		'同じ UTC 範囲の現在の候補を新しく検索します。以前の審査結果は不明のままです。残高の変更や支払いのキュー登録、以前の依頼の再実行は行いません。',
	recoveryAuditScope:
		'表示中の監査ページのみ読み込みました。記録が空でも以前の結果を証明しません。',
	recoveryFailed:
		'現在の証拠または本人の検証を取得できません。安全ロックは維持されます。',
}
const ko: Messages = {
	recoverGovernance: '결과를 알 수 없는 관리 작업 검토',
	recoverReview: '결과를 알 수 없는 수익 검토 확인',
	recoveryInspect: '현재 상태 읽기',
	recoveryAck:
		'이전 결과가 여전히 불명확함을 이해합니다. 이전 초안을 버리고 새로운 검토를 허용합니다.',
	recoveryConfirm: '새로운 검토 허용',
	recoveryUnavailable:
		'이전 형식 또는 잘못된 안전 표식을 작업에 연결할 수 없어 변경 잠금이 유지됩니다.',
	recoveryMissing:
		'이 키는 현재 존재하지 않으며 이전 결과는 여전히 불명확합니다. 다른 기존 키만 새로 검토할 수 있습니다.',
	recoveryRevision: '현재 버전',
	recoveryHint:
		'검증된 본인으로 정확한 키 상세와 감사 기록을 읽습니다. 현재 증거는 이전 결과를 증명하지 않으며 작업을 다시 실행하지 않습니다.',
	reviewRecoveryHint:
		'같은 UTC 범위의 현재 후보를 새로 검색합니다. 이전 검토 결과는 불명확합니다. 잔액 변경, 지급 대기열 등록, 이전 요청의 재실행은 하지 않습니다.',
	recoveryAuditScope:
		'표시된 감사 페이지만 읽었습니다. 빈 기록은 이전 결과를 증명하지 않습니다.',
	recoveryFailed:
		'현재 증거나 본인 확인을 읽지 못했습니다. 안전 잠금이 유지됩니다.',
}
export const adminSharedKeyRecoveryMessages = { en, zh, ja, ko }
