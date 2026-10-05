/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { guardrailMessages } from '../../account/guardrails/messages'
import { dataPolicyMessages } from '../data-policies/messages'
import { adminDomainMessages } from '../domain-messages'
import { adminGuardrailMessages } from '../guardrails/messages'
import { adminPresetMessages } from '../presets/messages'

export const policyWorkbenchLocales = ['en', 'zh', 'ja', 'ko'] as const
export type PolicyWorkbenchLocale = (typeof policyWorkbenchLocales)[number]
const bridge = {
	en: {
		checking: 'Verifying console access…',
		unverified: 'Console access could not be verified.',
		retry: 'Retry',
	},
	zh: {
		checking: '正在验证控制台权限…',
		unverified: '暂时无法验证控制台权限。',
		retry: '重试',
	},
	ja: {
		checking: 'コンソール権限を確認中…',
		unverified: 'コンソール権限を確認できません。',
		retry: '再試行',
	},
	ko: {
		checking: '콘솔 권한 확인 중…',
		unverified: '콘솔 권한을 확인할 수 없습니다.',
		retry: '다시 시도',
	},
}

/** This exact resource tree is registered by the legacy policy bridge. */
export function policyWorkbenchMessages(locale: PolicyWorkbenchLocale) {
	return {
		cinatoken: {
			bridge: bridge[locale],
			adminDomain: adminDomainMessages[locale],
			adminPresets: adminPresetMessages[locale],
			adminGuardrails: adminGuardrailMessages[locale],
			adminDataPolicies: dataPolicyMessages[locale],
			account: { guardrails: guardrailMessages[locale] },
		},
	}
}
