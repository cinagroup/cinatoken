/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { ToolEditFields } from './ToolEditFields'
import { ToolSaveReview, type ToolReviewOperation } from './ToolSaveReview'
import { ToolSecretValue } from './ToolSecretValue'
import type { ToolDetail } from './tools-contracts'
import { toolsPrefix, type ToolCredentialField } from './tools-domain'
import {
	toolEditorDefaults,
	toolEditorFormSchema,
	toolEditorPayload,
	type ToolEditorForm,
} from './tools-editor-form'
import type { AdminToolsProps, ToolsManager } from './use-admin-tools'

type Props = {
	detail: ToolDetail
	context: AdminToolsProps
	manager: ToolsManager
	onClose: () => void
}
export function ToolEditor(props: Props) {
	const { t } = useTranslation(),
		form = useForm<ToolEditorForm>({
			resolver: zodResolver(toolEditorFormSchema),
			defaultValues: toolEditorDefaults(props.detail),
		})
	const [review, setReview] = useState<ToolReviewOperation | null>(null),
		[ack, setAck] = useState(false),
		[lossAck, setLossAck] = useState(false),
		[secret, setSecret] = useState<{
			field: ToolCredentialField
			value: string
		} | null>(null),
		[busy, setBusy] = useState(false)
	const active = useRef(true),
		controller = useRef<AbortController | null>(null),
		draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
		revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const formRef = useRef(form),
		initial = useRef(toolEditorDefaults(props.detail))
	const submitBusy = useRef(false)
	useEffect(() => {
		active.current = true
		const currentForm = formRef.current,
			currentInitial = initial.current
		return () => {
			active.current = false
			controller.current?.abort()
			if (draftTimer.current) clearTimeout(draftTimer.current)
			if (revealTimer.current) clearTimeout(revealTimer.current)
			currentForm.reset(currentInitial)
		}
	}, [])
	const canEdit =
		props.context.canWrite &&
		!props.manager.deniedWrite &&
		props.detail.capabilities.can_write &&
		props.detail.familyState.editable
	const canReveal =
		props.context.canWrite &&
		!props.manager.deniedReveal &&
		props.detail.capabilities.can_reveal &&
		!busy &&
		props.manager.writeStatus === 'ready'
	function clearSecret() {
		setSecret(null)
		if (revealTimer.current) clearTimeout(revealTimer.current)
	}
	function secretInput() {
		if (draftTimer.current) clearTimeout(draftTimer.current)
		draftTimer.current = setTimeout(() => {
			if (active.current) props.onClose()
		}, 60_000)
	}
	async function begin(operation: ToolReviewOperation) {
		clearSecret()
		if (
			props.detail.family === 'ai-detection' &&
			['save', 'save_activate'].includes(operation) &&
			form.getValues('billingUnitChars') === ''
		) {
			form.setError('billingUnitChars', {
				type: 'required',
				message: 'Invalid unit',
			})
			return
		}
		const valid = ['save', 'save_activate'].includes(operation)
			? await form.trigger()
			: await form.trigger('reason')
		if (valid && active.current) {
			setAck(false)
			setLossAck(false)
			setReview(operation)
		}
	}
	async function submit() {
		if (!review || !ack || submitBusy.current) return
		submitBusy.current = true
		setBusy(true)
		const operation = review,
			abort = new AbortController()
		controller.current = abort
		const success = await props.manager.perform(
			{
				family: props.detail.family,
				provider: props.detail.provider,
				operation: ['save', 'save_activate'].includes(operation)
					? (operation as 'save' | 'save_activate')
					: 'reveal',
			},
			async (signal) => {
				signal.throwIfAborted()
				signal.addEventListener('abort', () => abort.abort(), { once: true })
				const options = {
					signal: abort.signal,
					expectedConsoleSubject: props.context.consoleSubject,
				}
				if (operation === 'save' || operation === 'save_activate') {
					const payload = toolEditorPayload(
						props.detail,
						form.getValues(),
						operation,
						lossAck
					)
					await props.context.api.saveAdminTool(props.detail, payload, options)
				} else {
					const result = await props.context.api.revealAdminTool(
						props.detail,
						{
							field: operation,
							expected_version: props.detail.version,
							reason: form.getValues('reason'),
						},
						options
					)
					if (active.current && !abort.signal.aborted) {
						setSecret({ field: result.field, value: result.value })
						revealTimer.current = setTimeout(() => {
							if (active.current) setSecret(null)
						}, 60_000)
					}
				}
			}
		)
		if (!active.current || abort.signal.aborted) return
		submitBusy.current = false
		controller.current = null
		setBusy(false)
		if (operation === 'save' || operation === 'save_activate' || !success)
			props.onClose()
		else {
			setReview(null)
			setAck(false)
		}
	}
	return (
		<div className='space-y-4'>
			{(!props.detail.familyState.editable ||
				props.detail.billingCurrency.value === null) && (
				<p role='alert'>
					{t(
						toolsPrefix +
							(props.detail.billingCurrency.value === null
								? 'invalidCurrency'
								: 'blockedSource')
					)}
				</p>
			)}
			{!canEdit && <p>{t(toolsPrefix + 'readOnly')}</p>}
			{secret && (
				<ToolSecretValue
					field={secret.field}
					value={secret.value}
					onClear={clearSecret}
				/>
			)}
			<form onSubmit={(event) => event.preventDefault()} className='space-y-4'>
				<ToolEditFields
					form={form}
					detail={props.detail}
					disabled={busy || !canEdit}
					canReveal={canReveal}
					onReveal={(field) => void begin(field)}
					onSecretInput={secretInput}
				/>
				<div className='flex flex-wrap gap-2'>
					<Button
						type='button'
						disabled={!canEdit || busy || props.manager.writeStatus !== 'ready'}
						onClick={() => void begin('save')}
					>
						{t(toolsPrefix + 'save')}
					</Button>
					<Button
						type='button'
						variant='outline'
						disabled={
							!canEdit ||
							busy ||
							props.manager.writeStatus !== 'ready' ||
							!props.detail.configuration.implemented
						}
						onClick={() => void begin('save_activate')}
					>
						{t(toolsPrefix + 'saveActivate')}
					</Button>
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(toolsPrefix + 'cancel')}
					</Button>
				</div>
			</form>
			{review && (
				<ToolSaveReview
					detail={props.detail}
					values={form.getValues()}
					operation={review}
					ack={ack}
					lossAck={lossAck}
					busy={busy}
					onAck={setAck}
					onLossAck={setLossAck}
					onSubmit={() => void submit()}
					onBack={props.onClose}
				/>
			)}
		</div>
	)
}
