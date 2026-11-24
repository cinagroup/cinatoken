/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { normalizeRequestLogModelIdPrefix } from '@octafuse/core/db/request-log-filters'
import { useTranslation } from 'react-i18next'
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
export function RequestLogPrefixFilter(props: {
	search: RequestLogSearch
	onSearch: (next: RequestLogSearch) => void
}) {
	const { t } = useTranslation()
	let invalid = false
	try {
		normalizeRequestLogModelIdPrefix(props.search.model_id_prefix)
	} catch {
		invalid = true
	}
	return (
		<Field data-invalid={invalid || undefined}>
			<FieldLabel htmlFor='request-log-model-prefix'>
				{t(prefix + 'modelIdPrefix')}
			</FieldLabel>
			<Input
				id='request-log-model-prefix'
				maxLength={600}
				value={props.search.model_id_prefix ?? ''}
				autoComplete='off'
				spellCheck={false}
				aria-invalid={invalid}
				aria-describedby='request-log-model-prefix-hint'
				onChange={(event) =>
					props.onSearch(
						updateRequestLogScopedFilter(
							props.search,
							'model_id_prefix',
							event.target.value
						)
					)
				}
			/>
			<FieldDescription id='request-log-model-prefix-hint'>
				{t(prefix + (invalid ? 'invalidModelPrefix' : 'modelPrefixHint'))}
			</FieldDescription>
		</Field>
	)
}
