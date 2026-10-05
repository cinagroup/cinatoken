/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { isOriginalGatewaySecret } from './simulator-api'
import {
	formatKeyOptionLabel,
	inputClass,
	labelClass,
	panelClass,
	tryParseProxyBaseUrl,
} from './simulator-utils'
import type { SimulatorState } from './use-simulator'

export function SimulatorSetup(props: { state: SimulatorState }) {
	const { t } = useTranslation()
	const state = props.state
	const rows = state.keysQuery.data?.data ?? []
	const selected = state.selectedKey
	const canVerify =
		state.keyEnabled &&
		!!selected &&
		isOriginalGatewaySecret(state.secretDraft) &&
		tryParseProxyBaseUrl(state.proxyBaseUrl).ok
	return (
		<section className={panelClass} aria-labelledby='simulator-connection'>
			<h2 id='simulator-connection' className='font-semibold'>
				{t('cinatoken.adminSimulator.connection')}
			</h2>
			<label className={labelClass} htmlFor='simulator-proxy'>
				{t('cinatoken.adminSimulator.proxyBaseUrl')}
			</label>
			<input
				id='simulator-proxy'
				type='url'
				className={inputClass}
				value={state.proxyBaseUrl}
				onChange={(event) => state.changeProxy(event.target.value)}
				disabled={state.sending}
				autoComplete='off'
				placeholder='http://127.0.0.1:8787'
			/>
			<p className='text-muted-foreground text-xs'>
				{t('cinatoken.adminSimulator.localDevHint')}
			</p>
			<div className='flex flex-wrap items-end gap-2'>
				<div className='min-w-48 flex-1'>
					<label className={labelClass} htmlFor='simulator-email'>
						{t('cinatoken.adminSimulator.emailContains')}
					</label>
					<input
						id='simulator-email'
						className={inputClass}
						value={state.email}
						maxLength={320}
						disabled={state.sending || !state.keyEnabled}
						onChange={(event) => state.setEmail(event.target.value)}
					/>
				</div>
				<button
					type='button'
					className='rounded-md border px-3 py-2 text-sm disabled:opacity-50'
					disabled={
						state.sending || state.keysQuery.isFetching || !state.keyEnabled
					}
					onClick={state.refreshKeys}
				>
					{t('cinatoken.adminSimulator.refreshList')}
				</button>
			</div>
			<label className={labelClass} htmlFor='simulator-key'>
				{t('cinatoken.adminSimulator.apiKeyRowId')}
			</label>
			<select
				id='simulator-key'
				className={inputClass}
				value={selected?.id ?? ''}
				disabled={
					state.sending || !state.keyEnabled || state.keysQuery.isPending
				}
				onChange={(event) => state.selectKey(event.target.value)}
			>
				<option value=''>{t('cinatoken.adminSimulator.select')}</option>
				{selected && !rows.some((row) => row.id === selected.id) && (
					<option value={selected.id}>{formatKeyOptionLabel(selected)}</option>
				)}
				{rows.map((row) => (
					<option key={row.id} value={row.id}>
						{formatKeyOptionLabel(row)} · {row.status}
					</option>
				))}
			</select>
			{state.keyEnabled && (
				<div className='text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs'>
					<span>
						{t('cinatoken.adminSimulator.keysShowing', {
							shown: rows.length,
							total: state.keysQuery.data?.total ?? 0,
						})}
					</span>
					<nav
						aria-label={t('cinatoken.adminSimulator.keyPages')}
						className='flex items-center gap-2'
					>
						<button
							type='button'
							className='rounded border px-2 py-1 disabled:opacity-50'
							disabled={
								state.page <= 1 || state.keysQuery.isFetching || state.sending
							}
							onClick={() => state.setPage(state.page - 1)}
						>
							{t('cinatoken.adminSimulator.previous')}
						</button>
						<span>
							{t('cinatoken.adminSimulator.page', { page: state.page })}
						</span>
						<button
							type='button'
							className='rounded border px-2 py-1 disabled:opacity-50'
							disabled={
								state.page * 100 >= (state.keysQuery.data?.total ?? 0) ||
								state.keysQuery.isFetching ||
								state.sending
							}
							onClick={() => state.setPage(state.page + 1)}
						>
							{t('cinatoken.adminSimulator.next')}
						</button>
					</nav>
				</div>
			)}
			{state.keysQuery.isFetching && (
				<p role='status' className='text-sm'>
					{t('cinatoken.adminSimulator.loading')}
				</p>
			)}
			{state.keysQuery.isError && (
				<p role='alert' className='text-destructive text-sm'>
					{t('cinatoken.adminSimulator.keysError')}
				</p>
			)}
			{!state.keyEnabled && state.context && (
				<p role='alert' className='text-sm'>
					{t('cinatoken.adminSimulator.keysForbidden')}
				</p>
			)}
			{selected && (
				<dl className='text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs break-all'>
					<dt>{t('cinatoken.adminSimulator.apiKeyRowId')}</dt>
					<dd>{selected.id}</dd>
					<dt>{t('cinatoken.adminSimulator.owner')}</dt>
					<dd>{selected.user_id}</dd>
					<dt>{t('cinatoken.adminSimulator.workspace')}</dt>
					<dd>{selected.workspace_id}</dd>
					<dt>{t('cinatoken.adminSimulator.keyBudget')}</dt>
					<dd>
						{selected.budget_spent} / {selected.budget_max ?? '∞'}{' '}
						{state.context?.billing_currency}
					</dd>
				</dl>
			)}
			<label className={labelClass} htmlFor='simulator-secret'>
				{t('cinatoken.adminSimulator.originalSecret')}
			</label>
			<div className='flex gap-2'>
				<input
					id='simulator-secret'
					className={inputClass}
					type='password'
					value={state.secretDraft}
					disabled={
						state.sending || state.verifying || !selected || !state.keyEnabled
					}
					autoComplete='off'
					spellCheck={false}
					onChange={(event) => state.setSecretDraft(event.target.value)}
				/>
				<button
					type='button'
					className='shrink-0 rounded-md border px-3 py-2 text-sm disabled:opacity-50'
					disabled={!canVerify || state.sending || state.verifying}
					onClick={() => void state.verifySecret()}
				>
					{t(
						state.verifying
							? 'cinatoken.adminSimulator.verifying'
							: 'cinatoken.adminSimulator.verifySecret'
					)}
				</button>
			</div>
			<p className='text-muted-foreground text-xs'>
				{t('cinatoken.adminSimulator.secretMemoryHint')}
			</p>
			{state.verified && (
				<p
					role='status'
					className='text-sm text-emerald-700 dark:text-emerald-400'
				>
					{t('cinatoken.adminSimulator.secretVerified')}
				</p>
			)}
			{state.secretError && (
				<p role='alert' className='text-destructive text-sm'>
					{t('cinatoken.adminSimulator.secretError')}
				</p>
			)}
		</section>
	)
}
