/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { AdminDomainRecoveryDialog } from '../AdminDomainRecoveryDialog'
import { ModelReadDialog } from './ModelReadDialog'
import { modelErrorKey } from './model-errors'
import { useModelsManager, type ModelManagerProps } from './use-models-manager'

export type ManagedModelEditorProps = ModelManagerProps & {
	id: string
	mode?: 'edit' | 'delete'
	onClose: () => void
	onSaved?: () => void
}
/** Routes and both model pages use the same complete editor and Models recovery domain. */
export function ManagedModelEditor(props: ManagedModelEditorProps) {
	const { t } = useTranslation()
	const manager = useModelsManager(props)
	const delivered = useRef(false)
	const onSaved = props.onSaved
	const onClose = props.onClose
	useEffect(() => {
		if (
			manager.notice &&
			!manager.mutation.isPending &&
			!manager.writeUnknown &&
			!delivered.current
		) {
			delivered.current = true
			onSaved?.()
			onClose()
		}
	}, [
		manager.notice,
		manager.mutation.isPending,
		manager.writeUnknown,
		onSaved,
		onClose,
	])
	if (manager.writeUnknown && !manager.mutation.isPending)
		return (
			<div className='space-y-3'>
				{(manager.hidden || manager.query.error) && (
					<p role='alert'>
						{t(modelErrorKey(manager.blockedError ?? manager.query.error))}
					</p>
				)}
				<AdminDomainRecoveryDialog recovery={manager.manualRecovery} />
				<Button variant='outline' onClick={props.onClose}>
					{t('cinatoken.adminDomain.cancel')}
				</Button>
			</div>
		)
	if (manager.hidden || manager.query.error)
		return (
			<div role='alert' className='space-y-3'>
				<p>{t(modelErrorKey(manager.blockedError ?? manager.query.error))}</p>
				<Button variant='outline' onClick={props.onClose}>
					{t('cinatoken.adminDomain.cancel')}
				</Button>
			</div>
		)
	return (
		<ModelReadDialog
			api={props.api}
			readOptions={manager.readOptions}
			prefix={manager.prefix}
			id={props.id}
			mode={props.mode ?? 'edit'}
			pending={manager.mutation.isPending}
			disabled={manager.disabled}
			error={manager.mutation.error}
			onSave={manager.save}
			onDelete={manager.remove}
			onClose={props.onClose}
		/>
	)
}
