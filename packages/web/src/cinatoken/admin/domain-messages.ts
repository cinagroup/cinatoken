/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const strings = {
	writing: [
		'A write is in progress. Recovery is available only after it finishes.',
		'写入正在执行，结束后才能核对恢复。',
		'書き込み中です。完了後に復旧の確認ができます。',
		'쓰기가 진행 중입니다. 완료 후에만 복구를 확인할 수 있습니다.',
	],
	policyConflict: [
		'The model route policy changed. Close this draft and reload the model before editing again.',
		'模型路由策略已变更，请关闭旧草稿并重新读取模型后再编辑。',
		'モデルのルーティング方針が変更されました。下書きを閉じ、モデルを再読み込みしてから編集してください。',
		'모델 라우팅 정책이 변경되었습니다. 이 초안을 닫고 모델을 다시 불러온 뒤 편집하세요.',
	],
	policyPrecondition: [
		'This write requires the route policy observed when the model was opened. Reload the model and start a new edit.',
		'此写入需要打开模型时的原始路由策略，请重新读取模型并开始新编辑。',
		'モデルを開いた時点のルーティング方針が必要です。モデルを再読み込みして新しく編集してください。',
		'모델을 열었을 때 확인한 라우팅 정책이 필요합니다. 모델을 다시 불러와 새로 편집하세요.',
	],
	unknown: [
		'A previous write has an unknown result. Further writes are locked.',
		'上次写入结果未知，已锁定后续写入。',
		'前回の書き込み結果が不明なため、以降の書き込みをロックしました。',
		'이전 쓰기 결과를 알 수 없어 이후 쓰기가 잠겼습니다.',
	],
	storageUnavailable: [
		'Recovery storage is unavailable. Writes remain locked.',
		'恢复存储不可用，写入保持锁定。',
		'復旧用ストレージを利用できません。書き込みはロックされたままです。',
		'복구 저장소를 사용할 수 없습니다. 쓰기는 잠긴 상태입니다.',
	],
	review: [
		'Review unknown result',
		'核对未知结果',
		'不明な結果を確認',
		'알 수 없는 결과 확인',
	],
	reviewHint: [
		'Verify the operation externally before unlocking. Fresh identity and current state will be checked twice. This never repeats the previous write.',
		'解锁前请在外部核对原操作。将重新验证身份并读取当前状态，随后再次验证身份；不会重放原写入。',
		'解除する前に外部で操作を確認してください。最新の本人確認と現在の状態を確認し、再度本人確認します。前回の操作は再実行しません。',
		'잠금을 해제하기 전에 외부에서 작업을 확인하세요. 최신 신원과 현재 상태를 확인한 뒤 신원을 다시 확인합니다. 이전 쓰기를 재실행하지 않습니다.',
	],
	external: [
		'I have checked the operation and its effects externally.',
		'我已在外部核对原操作及其影响。',
		'外部で元の操作と影響を確認しました。',
		'외부에서 원래 작업과 영향을 확인했습니다.',
	],
	acceptUnknown: [
		'I accept that the previous result remains unknown; discard the old draft and unlock.',
		'我接受原结果仍然未知；丢弃旧草稿并解锁。',
		'前回の結果が不明なままであることを了承し、古い下書きを破棄して解除します。',
		'이전 결과가 여전히 불명확함을 수락하고 이전 초안을 버린 뒤 잠금을 해제합니다.',
	],
	reviewFailed: [
		'Recovery checks failed or another operation owns this lock. Keep it locked and review again.',
		'核对失败或锁已属于另一笔操作；保持锁定并重新核对。',
		'確認に失敗したか、別の操作がロックを保持しています。ロックを維持して再確認してください。',
		'확인에 실패했거나 다른 작업이 이 잠금을 소유합니다. 잠금을 유지하고 다시 확인하세요.',
	],
	cancel: ['Cancel', '取消', 'キャンセル', '취소'],
	unlock: [
		'Verify and unlock',
		'验证并解锁',
		'確認して解除',
		'확인 후 잠금 해제',
	],
	installed: ['Installed', '已安装', 'インストール済み', '설치됨'],
	importable: [
		'{{count}} importable models',
		'{{count}} 个模型可导入',
		'{{count}} 件のモデルをインポート可能',
		'가져올 수 있는 모델 {{count}}개',
	],
	tiers: [
		'{{count}} pricing tiers',
		'{{count}} 个价格档位',
		'料金階層 {{count}} 件',
		'가격 구간 {{count}}개',
	],
	invalidEdit: [
		'The model edit link is invalid.',
		'模型编辑链接无效。',
		'モデル編集リンクが無効です。',
		'모델 편집 링크가 유효하지 않습니다.',
	],
	missingEdit: [
		'The requested model is not available in the current directory.',
		'当前目录中不存在该模型。',
		'指定されたモデルは現在の一覧にありません。',
		'요청한 모델이 현재 목록에 없습니다.',
	],
} as const
const languages = ['en', 'zh', 'ja', 'ko'] as const
export const adminDomainMessages = Object.fromEntries(
	languages.map((language, index) => [
		language,
		Object.fromEntries(
			Object.entries(strings).map(([key, values]) => [key, values[index]])
		),
	])
) as Record<(typeof languages)[number], Record<string, string>>
