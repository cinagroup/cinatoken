/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useRef, useState } from 'react'
import { useForm, type FieldPathValue } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import {
	Field,
	FieldGroup,
	FieldLabel,
	FieldSet,
	FieldLegend,
} from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { McpConfirmDialog } from './McpConfirmDialog'
import { McpField, McpNotice, mcpPrefix } from './McpFields'
import { McpPricingFields } from './McpPricingFields'
import type { McpServer } from './mcp-contracts'
import {
	applyMcpImport,
	emptyMcpServerDraft,
	mcpCreateInput,
	mcpServerDraftFrom,
	mcpUpdateInput,
	parseMcpClientConfig,
	type McpImportCandidate,
	type McpServerDraft,
} from './mcp-input'

export function McpServerForm(props: {
	current?: McpServer
	currency: 'USD' | 'CNY' | null
	busy: boolean
	canSave: boolean
	failure?: string | null
	onClose: () => void
	onSave: (draft: McpServerDraft) => Promise<boolean>
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const choiceId = useId()
	const form = useForm<McpServerDraft>({
		defaultValues: props.current
			? mcpServerDraftFrom(props.current)
			: emptyMcpServerDraft(),
	})
	const draft = form.watch()
	const dirty = form.formState.isDirty
	const [paste, setPaste] = useState('')
	const [choices, setChoices] = useState<McpImportCandidate[]>([])
	const [choice, setChoice] = useState(0)
	const [importError, setImportError] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [discard, setDiscard] = useState(false)
	function update<K extends keyof McpServerDraft>(
		key: K,
		value: FieldPathValue<McpServerDraft, K>
	): void {
		form.setValue(key, value, { shouldDirty: true })
		setError(null)
	}
	function close(): void {
		if (props.busy) return
		if (dirty || paste.trim()) setDiscard(true)
		else props.onClose()
	}
	function readImport(): void {
		const result = parseMcpClientConfig(paste)
		setImportError(!result.ok)
		setChoices(result.ok ? result.servers : [])
		setChoice(0)
	}
	function fillImport(): void {
		const selected = choices[choice]
		if (!selected) return
		const next = applyMcpImport(
			draft,
			selected,
			props.current ? 'edit' : 'create'
		)
		for (const key of ['name', 'slug', 'url', 'headers'] as const)
			form.setValue(key, next[key], { shouldDirty: true })
		setPaste('')
		setChoices([])
		setError(null)
	}
	async function submit(values: McpServerDraft): Promise<void> {
		if (props.busy || !props.canSave) return
		setError(null)
		try {
			if (props.current) {
				const patch = mcpUpdateInput(values, props.current)
				if (patch.pricing && !props.currency) {
					setError('currencyUnknown')
					return
				}
			} else {
				if (!props.currency) {
					setError('currencyUnknown')
					return
				}
				mcpCreateInput(values)
			}
		} catch {
			setError('invalidInput')
			return
		}
		if (!(await props.onSave(values))) setError('writeFailed')
	}
	return (
		<>
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open) close()
				}}
			>
				<DialogContent
					initialFocus={title}
					showCloseButton={false}
					className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl'
				>
					<DialogHeader>
						<DialogTitle ref={title} tabIndex={-1}>
							{t(mcpPrefix + (props.current ? 'edit' : 'create'))}
						</DialogTitle>
						<DialogDescription>
							{t(mcpPrefix + 'headersHint')}
						</DialogDescription>
					</DialogHeader>
					<form
						onSubmit={form.handleSubmit(submit)}
						className='flex min-w-0 flex-col gap-6'
					>
						{error && (
							<McpNotice
								message={
									error === 'writeFailed' &&
									props.failure &&
									props.failure !== 'saved'
										? props.failure
										: error
								}
								destructive
							/>
						)}
						<details className='rounded-lg border p-3'>
							<summary className='cursor-pointer font-medium'>
								{t(mcpPrefix + 'import')}
							</summary>
							<FieldGroup className='mt-4'>
								<McpField
									label='importText'
									value={paste}
									onChange={(value) => {
										setPaste(value)
										setChoices([])
										setImportError(false)
									}}
									multiline
									maxLength={150000}
									hint='importHint'
									disabled={props.busy}
								/>
								{importError && (
									<McpNotice message='importInvalid' destructive />
								)}
								<Button
									type='button'
									variant='outline'
									onClick={readImport}
									disabled={props.busy || !paste.trim()}
								>
									{t(mcpPrefix + 'parseImport')}
								</Button>
								{choices.length > 0 && (
									<>
										<Field>
											<FieldLabel htmlFor={choiceId}>
												{t(mcpPrefix + 'importChoice')}
											</FieldLabel>
											<NativeSelect
												id={choiceId}
												className='w-full'
												value={String(choice)}
												disabled={props.busy}
												onChange={(event) =>
													setChoice(Number(event.target.value))
												}
											>
												{choices.map((server, index) => (
													<NativeSelectOption key={index} value={String(index)}>
														{server.name || server.slug || String(index + 1)}
													</NativeSelectOption>
												))}
											</NativeSelect>
										</Field>
										<Button
											type='button'
											variant='outline'
											onClick={fillImport}
											disabled={props.busy}
										>
											{t(mcpPrefix + 'applyImport')}
										</Button>
									</>
								)}
							</FieldGroup>
						</details>
						<FieldSet>
							<FieldLegend>{t(mcpPrefix + 'connection')}</FieldLegend>
							<FieldGroup>
								<FieldGroup className='grid gap-4 sm:grid-cols-2'>
									<McpField
										label='slug'
										value={draft.slug}
										onChange={(value) => update('slug', value)}
										maxLength={40}
										required
										disabled={props.busy}
										readOnly={Boolean(props.current)}
										hint='slugHint'
									/>
									<McpField
										label='name'
										value={draft.name}
										onChange={(value) => update('name', value)}
										maxLength={120}
										required
										disabled={props.busy}
									/>
								</FieldGroup>
								<McpField
									label='description'
									value={draft.description}
									onChange={(value) => update('description', value)}
									maxLength={2000}
									multiline
									disabled={props.busy}
								/>
								<McpField
									label='url'
									value={draft.url}
									onChange={(value) => update('url', value)}
									maxLength={2048}
									required={!props.current}
									disabled={props.busy}
									hint={props.current ? 'urlHint' : undefined}
									placeholder={props.current?.urlMasked}
								/>
							</FieldGroup>
						</FieldSet>
						<FieldSet>
							<FieldLegend>{t(mcpPrefix + 'headers')}</FieldLegend>
							<FieldGroup>
								{draft.headers.map((row, index) => (
									<FieldGroup
										key={index}
										className='grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]'
									>
										<McpField
											label='headerName'
											value={row.key}
											onChange={(value) =>
												update(
													'headers',
													draft.headers.map((header, i) =>
														i === index ? { ...header, key: value } : header
													)
												)
											}
											maxLength={256}
											disabled={props.busy}
										/>
										<McpField
											label='headerValue'
											value={row.value}
											onChange={(value) =>
												update(
													'headers',
													draft.headers.map((header, i) =>
														i === index ? { ...header, value } : header
													)
												)
											}
											maxLength={4096}
											type='password'
											disabled={props.busy}
										/>
										<Button
											type='button'
											variant='outline'
											disabled={props.busy}
											onClick={() =>
												update(
													'headers',
													draft.headers.filter((_, i) => i !== index)
												)
											}
										>
											{t(mcpPrefix + 'removeHeader')}
										</Button>
									</FieldGroup>
								))}
								<Button
									type='button'
									variant='outline'
									disabled={props.busy || draft.headers.length >= 20}
									onClick={() =>
										update('headers', [
											...draft.headers,
											{ key: '', value: '' },
										])
									}
								>
									{t(mcpPrefix + 'addHeader')}
								</Button>
							</FieldGroup>
						</FieldSet>
						<FieldSet>
							<FieldLegend>
								{t(mcpPrefix + 'defaultPricing')}
								{props.currency ? ` · ${props.currency}` : ''}
							</FieldLegend>
							<McpPricingFields
								draft={draft.pricing}
								onChange={(value) => update('pricing', value)}
								currency={props.currency}
								disabled={props.busy}
							/>
						</FieldSet>
						<FieldGroup className='grid gap-4 sm:grid-cols-2'>
							<McpField
								label='timeout'
								value={draft.timeoutMs}
								onChange={(value) => update('timeoutMs', value)}
								maxLength={8}
								disabled={props.busy}
							/>
							<McpField
								label='maxBytes'
								value={draft.maxResponseBytes}
								onChange={(value) => update('maxResponseBytes', value)}
								maxLength={9}
								disabled={props.busy}
							/>
						</FieldGroup>
						<DialogFooter>
							<Button
								type='button'
								variant='outline'
								onClick={close}
								disabled={props.busy}
							>
								{t(mcpPrefix + 'cancel')}
							</Button>
							<Button
								type='submit'
								disabled={
									props.busy ||
									!props.canSave ||
									(!props.current && !props.currency)
								}
							>
								{t(mcpPrefix + 'save')}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			{discard && (
				<McpConfirmDialog
					title='cancel'
					message='discardHint'
					onClose={() => setDiscard(false)}
					onConfirm={props.onClose}
				/>
			)}
		</>
	)
}
