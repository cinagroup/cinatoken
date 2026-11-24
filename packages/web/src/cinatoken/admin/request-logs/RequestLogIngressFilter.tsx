/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { normalizeRequestLogIngressHost } from '@octafuse/core/db/request-log-filters'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Field,
	FieldDescription,
	FieldLabel,
} from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import {
	updateRequestLogScopedFilter,
	type RequestLogSearch,
} from './request-log-domain'

const prefix = 'cinatoken.adminRequestLogs.'
/** Keep partial input local. Only an explicit, valid apply changes the URL/query. */
export function RequestLogIngressFilter(props: {
	search: RequestLogSearch
	onSearch: (next: RequestLogSearch) => void
}) {
	const { t } = useTranslation()
	const [draft, setDraft] = useState(props.search.ingress_host ?? '')
	let value: string | undefined
	let invalid = false
	try {
		value = normalizeRequestLogIngressHost(draft)
	} catch {
		invalid = true
	}
	const unchanged =
		(!props.search.invalidFilter || props.search.invalidModelPrefix === true) &&
		!props.search.invalidIngressHost &&
		(value ?? '') === (props.search.ingress_host ?? '')
	function apply(): void {
		if (invalid || unchanged) return
		props.onSearch(
			updateRequestLogScopedFilter(props.search, 'ingress_host', value ?? '')
		)
	}
	return (
		<Field data-invalid={invalid || undefined}>
			<FieldLabel htmlFor='request-log-ingress-host'>
				{t(prefix + 'ingressHost')}
			</FieldLabel>
			<div className='flex items-center gap-2'>
				<Input
					id='request-log-ingress-host'
					value={draft}
					maxLength={255}
					autoComplete='off'
					spellCheck={false}
					aria-invalid={invalid}
					aria-describedby='request-log-ingress-host-hint'
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault()
							apply()
						}
					}}
				/>
				<Button
					type='button'
					variant='outline'
					disabled={invalid || unchanged}
					onClick={apply}
				>
					{t(prefix + 'applyIngressHost')}
				</Button>
			</div>
			<FieldDescription id='request-log-ingress-host-hint'>
				{t(prefix + (invalid ? 'invalidIngressHost' : 'ingressHostHint'))}
			</FieldDescription>
		</Field>
	)
}
