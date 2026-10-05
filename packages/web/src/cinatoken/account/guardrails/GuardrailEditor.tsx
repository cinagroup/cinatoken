import { useId, useState } from 'react'
import { useForm } from 'react-hook-form'
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
import {
	guardrailCreateInputSchema,
	type Guardrail,
	type GuardrailConfig,
} from '../../guardrail-contracts'
import { PolicyControls } from './PolicyControls'
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
	const [config, setConfig] = useState(props.editor.config)
	const [invalid, setInvalid] = useState(false)
	const form = useForm<{ name: string; description: string }>({
		defaultValues: {
			name: props.editor.row?.name ?? '',
			description: props.editor.row?.description ?? '',
		},
	})
	const text = (key: string) => t(`cinatoken.account.guardrails.${key}`)
	const isDefault = Boolean(
		props.editor.row?.isAccountDefault || props.editor.row?.isWorkspaceDefault
	)
	const disabled =
		!props.manager.canWrite ||
		Boolean(props.editor.row && !props.editor.row.canEdit)
	let title = props.editor.row ? 'newVersion' : 'editorTitle'
	if (props.editor.metadataOnly) title = 'editMetadata'
	let submitLabel = props.editor.metadataOnly ? 'confirm' : 'saveVersion'
	if (props.manager.pending) submitLabel = 'saving'
	async function save(values: { name: string; description: string }) {
		setInvalid(false)
		const parsed = guardrailCreateInputSchema.safeParse({
			...values,
			description: values.description.trim() || null,
			config,
		})
		if (!parsed.success) {
			setInvalid(true)
			return
		}
		let saved: boolean
		const row = props.editor.row
		if (props.editor.metadataOnly && row) {
			const input = isDefault
				? { description: parsed.data.description }
				: { name: parsed.data.name, description: parsed.data.description }
			saved = await props.manager.mutate({
				type: 'metadata',
				id: row.id,
				input,
			})
		} else if (row)
			saved = await props.manager.mutate({
				type: 'version',
				id: row.id,
				input: parsed.data,
			})
		else
			saved = await props.manager.mutate({ type: 'create', input: parsed.data })
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
					<DialogDescription>{text('editorHint')}</DialogDescription>
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
							{...form.register('name', {
								required: true,
								maxLength: 128,
								validate: (value) => Boolean(value.trim()),
							})}
						/>
					</label>
					<label className='block space-y-1' htmlFor={`${id}-description`}>
						<span>{text('description')}</span>
						<Textarea
							id={`${id}-description`}
							maxLength={1024}
							disabled={disabled}
							{...form.register('description', { maxLength: 1024 })}
						/>
					</label>
					{!props.editor.metadataOnly ? (
						<PolicyControls
							value={config}
							onChange={setConfig}
							accountDefault={Boolean(props.editor.row?.isAccountDefault)}
							currency={props.currency}
							disabled={disabled}
						/>
					) : null}
					{invalid || Object.keys(form.formState.errors).length > 0 ? (
						<Alert variant='destructive'>
							<AlertDescription>{text('configInvalid')}</AlertDescription>
						</Alert>
					) : null}
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
						<Button type='submit' disabled={disabled}>
							{text(submitLabel)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
