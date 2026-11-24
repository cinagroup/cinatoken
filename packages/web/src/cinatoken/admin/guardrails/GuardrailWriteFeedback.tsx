/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	adminGuardrailErrorKey,
	adminGuardrailWriteHintKey,
} from './guardrails-errors'

const prefix = 'cinatoken.adminGuardrails.'

export function GuardrailWriteFeedback(props: {
	error: unknown
	canResume?: boolean
	resumeKind?: 'binding' | 'metadata'
	onResume?: () => void
}) {
	const { t } = useTranslation()
	if (props.error == null) return null
	let hint = adminGuardrailWriteHintKey(props.error)
	if (props.canResume)
		hint =
			prefix +
			(props.resumeKind === 'metadata'
				? 'rejectedMetadataHint'
				: 'rejectedBindingHint')
	return (
		<div
			role='alert'
			className='text-destructive space-y-2 rounded-xl border p-3 text-sm'
		>
			<p>{t(adminGuardrailErrorKey(props.error))}</p>
			{hint && <p>{t(hint)}</p>}
			{props.canResume && props.onResume && (
				<Button type='button' variant='outline' onClick={props.onResume}>
					{t(prefix + 'resumeEditing')}
				</Button>
			)}
		</div>
	)
}
