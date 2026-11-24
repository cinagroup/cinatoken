/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { endpointErrorKey, endpointWriteHintKey } from './endpoint-errors'

const prefix = 'cinatoken.adminEndpoints.'

export function EndpointWriteFeedback(props: {
	error: unknown
	canResume?: boolean
	onResume?: () => void
}) {
	const { t } = useTranslation()
	if (props.error == null) return null
	const hint = props.canResume
		? prefix + 'rejectedDraftHint'
		: endpointWriteHintKey(props.error)
	return (
		<div
			role='alert'
			className='text-destructive space-y-2 rounded-xl border p-3 text-sm'
		>
			<p>{t(endpointErrorKey(props.error))}</p>
			{hint && <p>{t(hint)}</p>}
			{props.canResume && props.onResume && (
				<Button type='button' variant='outline' onClick={props.onResume}>
					{t(prefix + 'resumeEditing')}
				</Button>
			)}
		</div>
	)
}
