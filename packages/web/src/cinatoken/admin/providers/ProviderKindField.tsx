/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
	Field,
	FieldLabel,
	FieldDescription,
} from '../../../components/ui/field'
import {
	NativeSelect,
	NativeSelectOption,
} from '../../../components/ui/native-select'
import type { ProvidersApi, ProviderRequestOptions } from '../provider-api'

export function ProviderKindField(props: {
	api: ProvidersApi
	queryPrefix: readonly unknown[]
	readOptions?: (signal?: AbortSignal) => ProviderRequestOptions
	value: string
	disabled: boolean
	onChange: (value: string) => void
}) {
	const { t, i18n } = useTranslation(),
		prefix = 'cinatoken.adminProviders.'
	const query = useQuery({
		queryKey: [...props.queryPrefix, 'sync'],
		queryFn: ({ signal }) =>
			props.api.providerSyncReport(props.readOptions?.(signal) ?? { signal }),
		retry: false,
		refetchOnWindowFocus: false,
	})
	const choices = query.data?.kind_choices ?? [],
		known = choices.some((choice) => choice.kind === props.value)
	return (
		<Field>
			<FieldLabel htmlFor='provider-kind'>{t(prefix + 'kind')}</FieldLabel>
			<NativeSelect
				id='provider-kind'
				className='w-full'
				value={props.value}
				disabled={props.disabled}
				onChange={(event) => props.onChange(event.target.value)}
			>
				{props.value && !known && props.value !== '__custom__' && (
					<NativeSelectOption value={props.value}>
						{props.value}
					</NativeSelectOption>
				)}
				{!props.value && <NativeSelectOption value=''>—</NativeSelectOption>}
				<NativeSelectOption value='__custom__'>
					{t(prefix + 'kindCustom')}
				</NativeSelectOption>
				{choices.map((choice) => (
					<NativeSelectOption key={choice.kind} value={choice.kind}>
						{i18n.resolvedLanguage?.startsWith('zh')
							? choice.label_zh
							: choice.label_en}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<FieldDescription>{t(prefix + 'kindHint')}</FieldDescription>
		</Field>
	)
}
