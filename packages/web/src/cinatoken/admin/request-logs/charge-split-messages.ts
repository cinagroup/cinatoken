/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const requestChargeSplitMessages = {
	en: {
		chargeSplit: {
			title: 'User charge allocation',
			total: 'Total user charge',
			period: 'Period share (calculated)',
			wallet: 'Permanent wallet share',
			hint: 'Recorded allocation for this request, not an account balance or confirmation of a budget debit. The period share is total charge minus wallet share.',
			missing: 'The service did not provide the charge allocation.',
			inconsistent:
				'The stored amounts do not form a consistent charge allocation.',
		},
	},
	zh: {
		chargeSplit: {
			title: '用户收费分配',
			total: '用户总收费',
			period: '周期分量（计算值）',
			wallet: '永久池分量',
			hint: '本次请求记录的收费分配，不代表账户余额或预算扣款确认。周期分量为总收费减去永久池分量。',
			missing: '服务未提供本次收费分配。',
			inconsistent: '记录中的金额无法组成一致的收费分配。',
		},
	},
	ja: {
		chargeSplit: {
			title: 'ユーザー請求の配分',
			total: 'ユーザー請求合計',
			period: '期間分（計算値）',
			wallet: '永久ウォレット分',
			hint: 'このリクエストに記録された請求配分です。口座残高や予算引き落としの確認ではありません。期間分は請求合計からウォレット分を引いた値です。',
			missing: 'サービスから請求配分が提供されていません。',
			inconsistent: '記録された金額から整合性のある請求配分を計算できません。',
		},
	},
	ko: {
		chargeSplit: {
			title: '사용자 청구 배분',
			total: '사용자 총 청구액',
			period: '기간 분량 (계산값)',
			wallet: '영구 지갑 분량',
			hint: '이 요청에 기록된 청구 배분이며 계정 잔액이나 예산 차감 확인이 아닙니다. 기간 분량은 총 청구액에서 지갑 분량을 뺀 값입니다.',
			missing: '서비스에서 청구 배분을 제공하지 않았습니다.',
			inconsistent: '기록된 금액으로 일관된 청구 배분을 계산할 수 없습니다.',
		},
	},
} as const
