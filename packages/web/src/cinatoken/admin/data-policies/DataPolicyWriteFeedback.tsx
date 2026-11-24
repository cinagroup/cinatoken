/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	dataPolicyErrorKey,
	dataPolicyWriteHintKey,
} from './data-policy-errors'

const prefix = 'cinatoken.adminDataPolicies.'

export function DataPolicyWriteFeedback(props: {
	error: unknown
	canResume?: boolean
	onResume?: () => void
}) {
	const { t } = useTranslation()
	if (props.error == null) return null
	const hint = props.canResume
		? prefix + 'rejectedDraftHint'
		: dataPolicyWriteHintKey(props.error)
	return (
		<div
			role='alert'
			className='text-destructive space-y-2 rounded-xl border p-3 text-sm'
		>
			<p>{t(dataPolicyErrorKey(props.error))}</p>
			{hint && <p>{t(hint)}</p>}
			{props.canResume && props.onResume && (
				<Button type='button' variant='outline' onClick={props.onResume}>
					{t(prefix + 'resumeEditing')}
				</Button>
			)}
		</div>
	)
}
