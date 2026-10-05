/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('the actual application i18next runtime resolves shared domain messages in every locale', async () => {
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		'document'
	)
	const browserDocument = { documentElement: { lang: '' }, cookie: '' }
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: browserDocument,
	})
	try {
		// Import the actual registration, rather than creating a second test-only resource tree.
		const { default: runtime } = await import('../i18n')
		if (!runtime.isInitialized)
			await new Promise<void>((resolve) => runtime.once('initialized', resolve))
		const expected = {
			en: {
				policy: 'The model route policy changed.',
				review: 'Review unknown result',
				unknown: 'A previous write has an unknown result.',
				installed: 'Installed',
				importable: '3 importable models',
			},
			zh: {
				policy: '模型路由策略已变更',
				review: '核对未知结果',
				unknown: '上次写入结果未知',
				installed: '已安装',
				importable: '3 个模型可导入',
			},
			ja: {
				policy: 'モデルのルーティング方針が変更されました。',
				review: '不明な結果を確認',
				unknown: '前回の書き込み結果が不明',
				installed: 'インストール済み',
				importable: '3 件のモデルをインポート可能',
			},
			ko: {
				policy: '모델 라우팅 정책이 변경되었습니다.',
				review: '알 수 없는 결과 확인',
				unknown: '이전 쓰기 결과를 알 수 없어',
				installed: '설치됨',
				importable: '가져올 수 있는 모델 3개',
			},
		}
		for (const [language, messages] of Object.entries(expected)) {
			await runtime.changeLanguage(language)
			assert.equal(browserDocument.documentElement.lang, language)
			assert.ok(
				runtime
					.t('cinatoken.adminDomain.policyConflict')
					.startsWith(messages.policy)
			)
			assert.equal(runtime.t('cinatoken.adminDomain.review'), messages.review)
			assert.ok(
				runtime.t('cinatoken.adminDomain.unknown').startsWith(messages.unknown)
			)
			assert.equal(
				runtime.t('cinatoken.adminDomain.installed'),
				messages.installed
			)
			assert.equal(
				runtime.t('cinatoken.adminDomain.importable', { count: 3 }),
				messages.importable
			)
		}
	} finally {
		if (previousDocument)
			Object.defineProperty(globalThis, 'document', previousDocument)
		else Reflect.deleteProperty(globalThis, 'document')
	}
})
