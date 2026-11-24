/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import type {
	AdminGuardrailMetadataPatch,
	AdminGuardrailSummary,
} from './guardrails-contracts'

const prefix = 'cinatoken.adminGuardrails.'

export function GuardrailMetadataDialog(props: {
	row: AdminGuardrailSummary
	patch?: AdminGuardrailMetadataPatch
	disabled: boolean
	onClose: () => void
	onReview: (patch: AdminGuardrailMetadataPatch) => void
}) {
	const { t } = useTranslation()
	const id = useId()
	const title = useRef<HTMLHeadingElement>(null)
	const defaultRule = props.row.isWorkspaceDefault || props.row.isAccountDefault
	const [name, setName] = useState(props.patch?.name ?? props.row.name)
	const initialDescription =
		props.patch?.description === undefined
			? props.row.description
			: props.patch.description
	const [description, setDescription] = useState(initialDescription ?? '')
	const [validation, setValidation] = useState<string | null>(null)
	const changed =
		(!defaultRule && name !== props.row.name) ||
		description !== (props.row.description ?? '')
	function review(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault()
		if (props.disabled) return
		const patch: AdminGuardrailMetadataPatch = {}
		if (!defaultRule && name !== props.row.name) {
			const clean = name.trim()
			if (!clean || clean.length > 128) return setValidation('nameRequired')
			patch.name = clean
		}
		if (description !== (props.row.description ?? '')) {
			const clean = description.trim()
			if (clean.length > 1024) return setValidation('descriptionTooLong')
			patch.description = clean || null
		}
		setValidation(null)
		if (Object.keys(patch).length) props.onReview(patch)
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				initialFocus={title}
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1} className='break-words'>
						{t(prefix + 'metadataTitle', { name: props.row.name })}
					</DialogTitle>
					<DialogDescription className='break-all'>
						{t(prefix + 'workspace')}: {props.row.workspaceId} ·{' '}
						{t(prefix + 'owner')}: {props.row.ownerUserId}
					</DialogDescription>
				</DialogHeader>
				<form className='space-y-4' onSubmit={review}>
					{defaultRule && (
						<p id={id + '-default'} className='text-muted-foreground text-sm'>
							{t(prefix + 'defaultMetadataHint')}
						</p>
					)}
					<div className='space-y-2'>
						<Label htmlFor={id + '-name'}>{t(prefix + 'metadataName')}</Label>
						<Input
							id={id + '-name'}
							value={name}
							maxLength={128}
							disabled={props.disabled || defaultRule}
							aria-describedby={defaultRule ? id + '-default' : undefined}
							onChange={(event) => {
								setName(event.target.value)
								setValidation(null)
							}}
						/>
					</div>
					<div className='space-y-2'>
						<Label htmlFor={id + '-description'}>
							{t(prefix + 'description')}
						</Label>
						<Textarea
							id={id + '-description'}
							value={description}
							rows={4}
							maxLength={1024}
							disabled={props.disabled}
							onChange={(event) => {
								setDescription(event.target.value)
								setValidation(null)
							}}
						/>
					</div>
					{validation && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + validation)}
						</p>
					)}
					<DialogFooter>
						<Button type='button' variant='outline' onClick={props.onClose}>
							{t(prefix + 'cancel')}
						</Button>
						<Button type='submit' disabled={props.disabled || !changed}>
							{t(prefix + 'reviewMetadata')}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
