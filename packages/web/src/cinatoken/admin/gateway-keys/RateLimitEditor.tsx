/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import {
	NativeSelect,
	NativeSelectOption,
} from '../../../components/ui/native-select'
import type { RateLimit, RateLimitMode } from './rate-limit'

const prefix = 'cinatoken.adminGatewayKeys.'
export function RateLimitSummary(props: {
	value: RateLimit | undefined
	layer: 'user' | 'key'
	hint?: boolean
}) {
	const { t } = useTranslation()
	let label = t(prefix + 'rateLimitUnknown')
	if (props.value === null) label = t(prefix + 'rateLimitUnlimited')
	else if (props.value !== undefined)
		label = t(prefix + 'rateLimitValue', { rpm: props.value.rpm })
	return (
		<p className='text-sm tabular-nums'>
			{t(prefix + 'rateLimit')}: {label}
			{props.hint && (
				<span className='text-muted-foreground block text-xs'>
					{t(
						prefix +
							(props.layer === 'user'
								? 'rateLimitUserHint'
								: 'rateLimitKeyHint')
					)}
				</span>
			)}
		</p>
	)
}
export function RateLimitEditor(props: {
	current: RateLimit | undefined
	layer: 'user' | 'key'
	mode: RateLimitMode
	rpm: string
	disabled: boolean
	invalid?: boolean
	reason?: string
	onReason?: (value: string) => void
	onMode: (value: RateLimitMode) => void
	onRpm: (value: string) => void
}) {
	const { t } = useTranslation()
	const id = useId()
	return (
		<FieldSet className='gap-3 rounded-md border p-3' disabled={props.disabled}>
			<FieldLegend className='px-1' variant='label'>
				{t(prefix + 'rateLimit')}
			</FieldLegend>
			<RateLimitSummary value={props.current} layer={props.layer} hint />
			<FieldGroup className='gap-3'>
				<Field>
					<FieldLabel htmlFor={id + '-mode'}>
						{t(prefix + 'rateLimitUpdate')}
					</FieldLabel>
					<NativeSelect
						id={id + '-mode'}
						className='w-full'
						disabled={props.disabled}
						value={props.mode}
						onChange={(event) => {
							const value = event.target.value
							if (
								value === 'unchanged' ||
								value === 'unlimited' ||
								value === 'limited'
							)
								props.onMode(value)
						}}
					>
						{(['unchanged', 'unlimited', 'limited'] as const).map((mode) => (
							<NativeSelectOption key={mode} value={mode}>
								{t(prefix + 'rateLimitMode_' + mode)}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
				{props.mode === 'limited' && (
					<Field data-invalid={props.invalid || undefined}>
						<FieldLabel htmlFor={id + '-rpm'}>
							{t(prefix + 'rateLimit')}
						</FieldLabel>
						<Input
							id={id + '-rpm'}
							inputMode='numeric'
							maxLength={16}
							value={props.rpm}
							disabled={props.disabled}
							aria-invalid={props.invalid || undefined}
							aria-describedby={id + '-hint'}
							onChange={(event) => props.onRpm(event.target.value)}
						/>
					</Field>
				)}
				{props.mode !== 'unchanged' && props.onReason && (
					<Field>
						<FieldLabel htmlFor={id + '-reason'}>
							{t(prefix + 'reason')}
						</FieldLabel>
						<Input
							id={id + '-reason'}
							value={props.reason ?? ''}
							disabled={props.disabled}
							maxLength={256}
							onChange={(event) => props.onReason?.(event.target.value)}
						/>
					</Field>
				)}
				<FieldDescription id={id + '-hint'}>
					{t(prefix + 'rateLimitHint')}
				</FieldDescription>
				{props.invalid && (
					<p role='alert' className='text-destructive text-xs'>
						{t(prefix + 'rateLimitInvalid')}
					</p>
				)}
			</FieldGroup>
		</FieldSet>
	)
}
