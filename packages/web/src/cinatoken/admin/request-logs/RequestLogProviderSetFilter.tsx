/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { normalizeRequestLogProviderIds } from '@octafuse/core/db/request-log-filters'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
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
const schema = z.object({
	value: z.string().refine((value) => {
		try {
			normalizeRequestLogProviderIds(value)
			return true
		} catch {
			return false
		}
	}),
})

export function RequestLogProviderSetFilter(props: {
	search: RequestLogSearch
	onSearch: (search: RequestLogSearch) => void
}) {
	const { t } = useTranslation()
	const form = useForm({
		resolver: zodResolver(schema),
		defaultValues: { value: props.search.provider_ids ?? '' },
	})
	const invalid =
		Boolean(form.formState.errors.value) ||
		props.search.invalidProviderIds === true
	return (
		<form
			onSubmit={form.handleSubmit(({ value }) =>
				props.onSearch(
					updateRequestLogScopedFilter(props.search, 'provider_ids', value)
				)
			)}
		>
			<Field data-invalid={invalid || undefined}>
				<FieldLabel htmlFor='request-log-provider-set'>
					{t(prefix + 'providerIds')}
				</FieldLabel>
				<Input
					id='request-log-provider-set'
					maxLength={6009}
					autoComplete='off'
					spellCheck={false}
					aria-invalid={invalid}
					aria-describedby='request-log-provider-set-hint'
					{...form.register('value')}
				/>
				<FieldDescription id='request-log-provider-set-hint'>
					{t(prefix + (invalid ? 'invalidProviderIds' : 'providerIdsHint'))}
				</FieldDescription>
				<div className='flex flex-wrap gap-2'>
					<Button type='submit' variant='outline' size='sm'>
						{t(prefix + 'applyProviderIds')}
					</Button>
					<Button
						type='button'
						variant='ghost'
						size='sm'
						onClick={() => {
							form.reset({ value: '' })
							props.onSearch(
								updateRequestLogScopedFilter(props.search, 'provider_ids', '')
							)
						}}
					>
						{t(prefix + 'clearProviderIds')}
					</Button>
				</div>
			</Field>
		</form>
	)
}
