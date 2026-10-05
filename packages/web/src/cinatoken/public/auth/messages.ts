/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	loading: 'Preparing sign-in…',
	waiting: 'Complete sign-in in the CinaAuth window.',
	verifying: 'Verifying your sign-in…',
	cancel: 'Cancel',
	refocus: 'Show sign-in window',
	retry: 'Retry sign-in',
	errors: {
		oidcFailed: 'Sign-in could not be completed. Please try again.',
		sessionUnavailable: 'Your sign-in could not be verified. Please try again.',
		adminForbidden: 'This account does not have access to the admin console.',
		popupExpired: 'Sign-in timed out. Please start again.',
		popupBlocked: 'Allow the sign-in window, then try again.',
		runtimeUnavailable: 'Sign-in is temporarily unavailable. Please try again.',
	},
}
const zh: typeof en = {
	loading: '正在准备登录…',
	waiting: '请在 CinaAuth 窗口中完成登录。',
	verifying: '正在验证登录…',
	cancel: '取消',
	refocus: '显示登录窗口',
	retry: '重试登录',
	errors: {
		oidcFailed: '未能完成登录，请重试。',
		sessionUnavailable: '未能验证登录状态，请重试。',
		adminForbidden: '此账户没有管理控制台的访问权限。',
		popupExpired: '登录已超时，请重新开始。',
		popupBlocked: '请允许打开登录窗口，然后重试。',
		runtimeUnavailable: '登录暂时不可用，请重试。',
	},
}
const ja: typeof en = {
	loading: 'ログインを準備しています…',
	waiting: 'CinaAuth のウィンドウでログインを完了してください。',
	verifying: 'ログインを確認しています…',
	cancel: 'キャンセル',
	refocus: 'ログインウィンドウを表示',
	retry: 'ログインを再試行',
	errors: {
		oidcFailed: 'ログインを完了できませんでした。もう一度お試しください。',
		sessionUnavailable:
			'ログインを確認できませんでした。もう一度お試しください。',
		adminForbidden:
			'このアカウントには管理コンソールへのアクセス権がありません。',
		popupExpired: 'ログインがタイムアウトしました。もう一度開始してください。',
		popupBlocked: 'ログインウィンドウを許可してから、もう一度お試しください。',
		runtimeUnavailable:
			'現在ログインを利用できません。もう一度お試しください。',
	},
}
const ko: typeof en = {
	loading: '로그인을 준비하고 있습니다…',
	waiting: 'CinaAuth 창에서 로그인을 완료하세요.',
	verifying: '로그인을 확인하고 있습니다…',
	cancel: '취소',
	refocus: '로그인 창 표시',
	retry: '로그인 다시 시도',
	errors: {
		oidcFailed: '로그인을 완료하지 못했습니다. 다시 시도하세요.',
		sessionUnavailable: '로그인을 확인하지 못했습니다. 다시 시도하세요.',
		adminForbidden: '이 계정에는 관리 콘솔 접근 권한이 없습니다.',
		popupExpired: '로그인 시간이 초과되었습니다. 다시 시작하세요.',
		popupBlocked: '로그인 창을 허용한 후 다시 시도하세요.',
		runtimeUnavailable: '지금은 로그인할 수 없습니다. 다시 시도하세요.',
	},
}

export const publicAuthMessages = { en, zh, ja, ko }
export type PublicAuthMessages = typeof en
