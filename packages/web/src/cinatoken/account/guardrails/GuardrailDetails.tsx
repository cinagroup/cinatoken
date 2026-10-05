import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { GuardrailEditorState } from './GuardrailEditor'
import { PolicyControls } from './PolicyControls'
import type {
	GuardrailAction,
	GuardrailsManager,
} from './use-guardrails-manager'

export function GuardrailDetails(props: {
	manager: GuardrailsManager
	userId: string
	onEdit(state: GuardrailEditorState): void
	onConfirm(action: GuardrailAction, label: string): void
}) {
	const { t, i18n } = useTranslation()
	const [keyId, setKeyId] = useState('')
	const [inspected, setInspected] = useState<number | null>(null)
	const text = (key: string) => t(`cinatoken.account.guardrails.${key}`)
	const manager = props.manager
	const row = manager.selected
	const keys =
		!manager.blocked && manager.canUseKeys
			? (manager.keys.data?.keys.filter((key) => key.status === 'active') ?? [])
			: []
	const time = (value: string) =>
		new Intl.DateTimeFormat(i18n.resolvedLanguage, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(value))
	if (!row || manager.blocked || manager.list.isError) return null
	const ready = manager.versions.isSuccess && manager.assignments.isSuccess
	const inspectedVersion = ready
		? manager.versions.data?.data.find(
				(version) => version.version === inspected
			)
		: null
	return (
		<Card aria-label={text('details')}>
			<CardHeader>
				<CardTitle className='break-words'>
					{row.name} — {text('details')}
				</CardTitle>
			</CardHeader>
			<CardContent className='space-y-6'>
				{manager.versions.isError || manager.assignments.isError ? (
					<Alert variant='destructive'>
						<AlertDescription>
							{text('detailsFailed')}{' '}
							<Button variant='link' onClick={() => void manager.refresh()}>
								{text('retry')}
							</Button>
						</AlertDescription>
					</Alert>
				) : null}
				{!ready && !manager.versions.isError && !manager.assignments.isError ? (
					<p role='status'>{text('loading')}</p>
				) : null}
				{ready ? (
					<>
						<section className='space-y-3' aria-label={text('versions')}>
							<h3 className='font-medium'>{text('versions')}</h3>
							{manager.versions.data?.data.map((version) => (
								<div
									key={version.id}
									className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3'
								>
									<div className='space-y-1'>
										<p className='flex items-center gap-2'>
											{text('version')} {version.version}
											{version.version === row.designatedVersion ? (
												<Badge>{text('designated')}</Badge>
											) : null}
										</p>
										<p className='text-muted-foreground text-xs'>
											{time(version.createdAt)}
										</p>
									</div>
									<div className='flex flex-wrap gap-2'>
										<Button
											variant='outline'
											size='sm'
											onClick={() => setInspected(version.version)}
										>
											{text('showConfig')}
										</Button>
										{row.canEdit && version.config ? (
											<Button
												variant='outline'
												size='sm'
												disabled={!manager.canWrite}
												onClick={() =>
													props.onEdit({
														row,
														config: version.config!,
														metadataOnly: false,
													})
												}
											>
												{text('newVersion')}
											</Button>
										) : null}
										{row.canEdit &&
										version.version !== row.designatedVersion ? (
											<Button
												size='sm'
												disabled={!manager.canWrite}
												onClick={() =>
													props.onConfirm(
														{
															type: 'designate',
															id: row.id,
															version: version.version,
														},
														t('cinatoken.account.guardrails.confirmDesignate', {
															version: version.version,
														})
													)
												}
											>
												{text('designate')}
											</Button>
										) : null}
									</div>
								</div>
							))}
							{inspectedVersion ? (
								<div className='space-y-3 rounded-lg border p-3'>
									<h4 className='font-medium'>
										{text('versionConfig')} · {inspectedVersion.version}
									</h4>
									<p className='text-muted-foreground text-xs'>
										{text('patternPrivate')}
									</p>
									{inspectedVersion.config ? (
										<PolicyControls
											key={inspectedVersion.id}
											value={inspectedVersion.config}
											onChange={() => undefined}
											accountDefault={row.isAccountDefault}
											currency={manager.list.data?.budgetCurrency ?? 'USD'}
											disabled
										/>
									) : (
										<p>{text('configUnavailable')}</p>
									)}
								</div>
							) : null}
						</section>
						<section className='space-y-3' aria-label={text('assignments')}>
							<h3 className='font-medium'>{text('assignments')}</h3>
							{row.isAccountDefault ? (
								<p className='text-muted-foreground text-sm'>
									{text('implicitAccountDefault')}
								</p>
							) : null}
							{row.isWorkspaceDefault ? (
								<p className='text-muted-foreground text-sm'>
									{text('implicitDefault')}
								</p>
							) : null}
							{manager.assignments.data?.data.length === 0 &&
							!row.isAccountDefault &&
							!row.isWorkspaceDefault ? (
								<p className='text-muted-foreground text-sm'>
									{text('noAssignments')}
								</p>
							) : null}
							{manager.assignments.data?.data.map((binding) => (
								<div
									key={binding.id}
									className='flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3'
								>
									<div className='min-w-0 space-y-1 text-sm'>
										<p>
											{text(
												binding.scopeType === 'user' ? 'userBinding' : 'key'
											)}
										</p>
										<p className='font-mono text-xs break-all'>
											{binding.scopeId}
										</p>
										<p className='text-muted-foreground'>
											{text('provenance')}:{' '}
											{text(`management_${binding.managementSource ?? 'user'}`)}
										</p>
										<p className='text-muted-foreground text-xs'>
											{time(binding.createdAt)}
										</p>
									</div>
									{binding.canUnbind ? (
										<Button
											variant='outline'
											size='sm'
											disabled={!manager.canWrite}
											onClick={() =>
												props.onConfirm(
													{
														type: 'unbind',
														id: row.id,
														scopeType: binding.scopeType,
														scopeId: binding.scopeId,
													},
													t('cinatoken.account.guardrails.confirmUnbind', {
														scope: binding.scopeId,
													})
												)
											}
										>
											{text('unbind')}
										</Button>
									) : (
										<Badge variant='secondary'>{text('readonly')}</Badge>
									)}
								</div>
							))}
							{row.canAssign ? (
								<div className='bg-muted/30 space-y-3 rounded-lg p-3'>
									<Button
										variant='outline'
										disabled={!manager.canWrite}
										onClick={() =>
											props.onConfirm(
												{
													type: 'bind',
													id: row.id,
													scopeType: 'user',
													scopeId: props.userId,
												},
												t('cinatoken.account.guardrails.confirmBind', {
													scope: text('userBinding'),
												})
											)
										}
									>
										{text('bindAccount')}
									</Button>
									{manager.keySelectionAllowed ? (
										<>
											<div className='flex flex-col gap-2 sm:flex-row'>
												<label
													className='min-w-0 flex-1 space-y-1'
													htmlFor='guardrail-binding-key'
												>
													<span className='text-sm'>{text('key')}</span>
													<select
														id='guardrail-binding-key'
														className='bg-background h-9 w-full min-w-0 rounded-md border px-2 text-sm'
														value={keyId}
														disabled={!manager.canWrite || !keys.length}
														onChange={(event) => setKeyId(event.target.value)}
													>
														<option value=''>{text('bindKey')}</option>
														{keys.map((key) => (
															<option key={key.id} value={key.id}>
																{key.name || key.key}
															</option>
														))}
													</select>
												</label>
												<Button
													className='sm:self-end'
													disabled={
														!manager.canWrite ||
														!keys.some((key) => key.id === keyId)
													}
													onClick={() =>
														props.onConfirm(
															{
																type: 'bind',
																id: row.id,
																scopeType: 'api_key',
																scopeId: keyId,
															},
															t('cinatoken.account.guardrails.confirmBind', {
																scope:
																	keys.find((key) => key.id === keyId)?.name ||
																	keyId,
															})
														)
													}
												>
													{text('bind')}
												</Button>
											</div>
											{!keys.length ? (
												<p className='text-muted-foreground text-sm'>
													{text('noKeys')}
												</p>
											) : null}
										</>
									) : null}
								</div>
							) : null}
						</section>
					</>
				) : null}
			</CardContent>
		</Card>
	)
}
