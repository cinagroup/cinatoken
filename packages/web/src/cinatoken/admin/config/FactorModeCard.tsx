/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '../../../components/ui/alert'
import { Button } from '../../../components/ui/button'
import {
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
	CardFooter,
} from '../../../components/ui/card'
import {
	FieldGroup,
	Field,
	FieldLabel,
	FieldDescription,
} from '../../../components/ui/field'
import {
	NativeSelect,
	NativeSelectOption,
} from '../../../components/ui/native-select'
import type {
	AdminConfigFactorMode,
	AdminConfigOverview,
} from './config-contracts'
import { factorModeDirty } from './config-factor-mode'

const prefix = 'cinatoken.adminConfigFull.'
const sources = {
	configured: 'sourceConfigured',
	missing: 'sourceMissing',
	invalid: 'sourceInvalid',
} as const
export function FactorModeCard(props: {
	field: AdminConfigOverview['userChargedCostFactorMode']
	draft: AdminConfigFactorMode | null
	canWrite: boolean
	canEdit: boolean
	locked: boolean
	onChange: (value: AdminConfigFactorMode) => void
	onSave: (value: AdminConfigFactorMode) => void
	onDiscard: () => void
}) {
	const { t } = useTranslation()
	const field = props.field
	const dirty = factorModeDirty(field, props.draft)
	const value = props.draft ?? field?.value
	return (
		<Card aria-labelledby='admin-config-factor-mode-title'>
			<CardHeader>
				<CardTitle id='admin-config-factor-mode-title'>
					{t(prefix + 'factorMode')}
				</CardTitle>
				<CardDescription>{t(prefix + 'factorModeHint')}</CardDescription>
			</CardHeader>
			<CardContent className='flex flex-col gap-4'>
				<p className='text-sm'>{t(prefix + 'factorMultiplyHint')}</p>
				<p className='text-sm'>{t(prefix + 'factorMinHint')}</p>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'factorModeScope')}
				</p>
				{field ? (
					<p className='text-sm'>
						{t(prefix + 'current')}: {field.value} ·{' '}
						{t(prefix + sources[field.source])}
					</p>
				) : (
					<p role='status'>{t(prefix + 'factorModeUnavailable')}</p>
				)}
				{props.locked ? (
					<Alert>
						<AlertDescription>{t(prefix + 'unconfirmed')}</AlertDescription>
					</Alert>
				) : null}
				{props.canWrite && field && !props.locked ? (
					<FieldGroup>
						<Field data-disabled={!props.canEdit}>
							<FieldLabel htmlFor='admin-config-factor-mode'>
								{t(prefix + 'selectFactorMode')}
							</FieldLabel>
							<NativeSelect
								id='admin-config-factor-mode'
								value={value}
								disabled={!props.canEdit}
								aria-describedby='admin-config-factor-mode-dirty'
								onChange={(event) => {
									if (
										event.target.value === 'multiply' ||
										event.target.value === 'min'
									)
										props.onChange(event.target.value)
								}}
							>
								<NativeSelectOption value='multiply'>
									{t(prefix + 'factorMultiply')}
								</NativeSelectOption>
								<NativeSelectOption value='min'>
									{t(prefix + 'factorMin')}
								</NativeSelectOption>
							</NativeSelect>
							<FieldDescription id='admin-config-factor-mode-dirty'>
								{t(prefix + (dirty ? 'factorModeDirty' : 'factorModeClean'))}
							</FieldDescription>
						</Field>
					</FieldGroup>
				) : null}
			</CardContent>
			{props.canWrite && field && !props.locked ? (
				<CardFooter className='flex flex-wrap gap-2'>
					<Button
						type='button'
						disabled={!props.canEdit || !dirty}
						onClick={() => {
							if (value) props.onSave(value)
						}}
					>
						{t(prefix + 'saveFactorMode')}
					</Button>
					<Button
						type='button'
						variant='outline'
						disabled={!props.canEdit || props.draft === null}
						onClick={props.onDiscard}
					>
						{t(prefix + 'discardFactorMode')}
					</Button>
				</CardFooter>
			) : null}
		</Card>
	)
}
