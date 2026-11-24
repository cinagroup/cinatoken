import { useId, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { type Guardrail, type GuardrailConfig } from '../../guardrail-contracts'
import { PolicyControls } from './PolicyControls'
import {
	guardrailMetadataDraft,
	guardrailNewInput,
	guardrailNewVersionInput,
	type GuardrailEditorValues,
} from './guardrail-editor-form'
import {
	guardrailErrorKey,
	type GuardrailsManager,
} from './use-guardrails-manager'

export type GuardrailEditorState = {
	row: Guardrail | null
	config: GuardrailConfig
	metadataOnly: boolean
}
export function GuardrailEditor(props: {
	editor: GuardrailEditorState
	manager: GuardrailsManager
	onClose(): void
	currency: string
}) {
	const { t } = useTranslation()
	const id = useId()
	const [initialRow] = useState(props.editor.row)
	const [config, setConfig] = useState(props.editor.config)
	const [invalid, setInvalid] = useState(false)
	const form = useForm<GuardrailEditorValues>({
		defaultValues: {
			name: props.editor.row?.name ?? '',
			description: props.editor.row?.description ?? '',
		},
	})
	const text = (key: string) => t(`cinatoken.account.guardrails.${key}`)
	const isDefault = Boolean(
		initialRow?.isAccountDefault || initialRow?.isWorkspaceDefault
	)
	const disabled =
		!props.manager.canWrite ||
		Boolean(props.editor.row && !props.editor.row.canEdit)
	const values = useWatch({ control: form.control })
	const metadata =
		props.editor.metadataOnly && initialRow
			? guardrailMetadataDraft(initialRow, values)
			: null
	let title = props.editor.row ? 'newVersion' : 'editorTitle'
	if (props.editor.metadataOnly) title = 'editMetadata'
	let submitLabel = props.editor.metadataOnly ? 'confirm' : 'saveVersion'
	if (props.manager.pending) submitLabel = 'saving'
	async function save(values: GuardrailEditorValues) {
		if (disabled) return
		setInvalid(false)
		let saved: boolean
		try {
			if (props.editor.metadataOnly && initialRow) {
				const draft = guardrailMetadataDraft(initialRow, values)
				if (draft.kind === 'invalid') return setInvalid(true)
				if (draft.kind === 'unchanged') return
				saved = await props.manager.mutate({
					type: 'metadata',
					id: initialRow.id,
					input: draft.input,
				})
			} else if (initialRow)
				saved = await props.manager.mutate({
					type: 'version',
					id: initialRow.id,
					input: guardrailNewVersionInput(initialRow, values, config),
				})
			else
				saved = await props.manager.mutate({
					type: 'create',
					input: guardrailNewInput(values, config),
				})
		} catch {
			setInvalid(true)
			return
		}
		if (saved) props.onClose()
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.manager.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[85dvh] overflow-y-auto sm:max-w-3xl'
				showCloseButton={!props.manager.pending}
			>
				<DialogHeader>
					<DialogTitle>{text(title)}</DialogTitle>
					<DialogDescription>
						{props.editor.metadataOnly
							? t('cinatoken.account.guardrails.metadataHint', {
									name: initialRow?.name,
								})
							: text('editorHint')}
					</DialogDescription>
				</DialogHeader>
				<form
					className='space-y-5'
					onSubmit={form.handleSubmit((values) => void save(values))}
				>
					<label className='block space-y-1' htmlFor={`${id}-name`}>
						<span>{text('name')}</span>
						<Input
							id={`${id}-name`}
							maxLength={128}
							disabled={disabled || isDefault}
							aria-describedby={isDefault ? id + '-default' : undefined}
							{...form.register('name', { onChange: () => setInvalid(false) })}
						/>
					</label>
					{isDefault && (
						<p id={id + '-default'} className='text-muted-foreground text-xs'>
							{text('defaultNameHint')}
						</p>
					)}
					<label className='block space-y-1' htmlFor={`${id}-description`}>
						<span>{text('description')}</span>
						<Textarea
							id={`${id}-description`}
							maxLength={1024}
							disabled={disabled}
							{...form.register('description', {
								onChange: () => setInvalid(false),
							})}
						/>
					</label>
					{!props.editor.metadataOnly ? (
						<PolicyControls
							value={config}
							onChange={(value) => {
								setConfig(value)
								setInvalid(false)
							}}
							accountDefault={Boolean(props.editor.row?.isAccountDefault)}
							currency={props.currency}
							disabled={disabled}
						/>
					) : null}
					{invalid || Object.keys(form.formState.errors).length > 0 ? (
						<Alert variant='destructive'>
							<AlertDescription>
								{text(
									props.editor.metadataOnly
										? 'metadataInvalid'
										: 'configInvalid'
								)}
							</AlertDescription>
						</Alert>
					) : null}
					{metadata?.kind === 'unchanged' && (
						<p role='status' className='text-muted-foreground text-sm'>
							{text('noChanges')}
						</p>
					)}
					{props.manager.error ? (
						<Alert variant='destructive'>
							<AlertDescription>
								{text(guardrailErrorKey(props.manager.error))}
							</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button
							type='button'
							variant='outline'
							disabled={props.manager.pending}
							onClick={props.onClose}
						>
							{text('cancel')}
						</Button>
						<Button
							type='submit'
							disabled={disabled || metadata?.kind === 'unchanged'}
						>
							{text(submitLabel)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
