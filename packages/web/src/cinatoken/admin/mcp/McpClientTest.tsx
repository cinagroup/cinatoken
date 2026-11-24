/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { McpClientResponse } from './McpClientResponse'
import { McpField, McpJson, McpNotice, mcpPrefix } from './McpFields'
import type { AdminMcpApi } from './mcp-api'
import {
	mcpClientCurl,
	MCP_CLIENT_METHODS,
	MCP_CLIENT_VERSIONS,
	type McpClientMethod,
} from './mcp-client'
import type { McpServerSummary } from './mcp-contracts'
import type { McpSession } from './use-mcp-admin'
import { useMcpClient } from './use-mcp-client'

export function McpClientTest(props: {
	api: AdminMcpApi
	session: McpSession
	servers: McpServerSummary[]
	initialSlug: string
}) {
	const { t } = useTranslation()
	const state = useMcpClient(props)
	const id = useId()
	const [copied, setCopied] = useState<'copied' | 'copyFailed' | null>(null)
	async function copy(): Promise<void> {
		if (!state.request) return
		try {
			await navigator.clipboard.writeText(mcpClientCurl(state.request))
			setCopied('copied')
		} catch {
			setCopied('copyFailed')
		}
	}
	return (
		<Card className='min-w-0'>
			<CardHeader>
				<CardTitle>{t(mcpPrefix + 'clientTitle')}</CardTitle>
				<CardDescription>{t(mcpPrefix + 'clientHint')}</CardDescription>
			</CardHeader>
			<CardContent className='flex min-w-0 flex-col gap-5'>
				<FieldGroup className='grid gap-4 md:grid-cols-2'>
					<McpField
						label='proxy'
						value={state.proxy}
						onChange={state.setProxy}
						maxLength={2048}
						placeholder='http://127.0.0.1:8787'
					/>
					<Field>
						<FieldLabel htmlFor={`${id}-slug`}>
							{t(mcpPrefix + 'slug')}
						</FieldLabel>
						<NativeSelect
							id={`${id}-slug`}
							className='w-full'
							value={state.slug}
							onChange={(event) => state.setSlug(event.target.value)}
						>
							<NativeSelectOption value=''>
								{t(mcpPrefix + 'aggregate')}
							</NativeSelectOption>
							{props.servers.map((server) => (
								<NativeSelectOption key={server.id} value={server.slug}>
									{server.name} · {server.slug}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<McpField
						label='keyEmail'
						value={state.email}
						onChange={state.setEmail}
						maxLength={320}
					/>
					<Field className='justify-end'>
						<Button
							variant='outline'
							onClick={() => void state.loadKeys()}
							disabled={state.loadingKeys}
						>
							{t(mcpPrefix + 'loadKeys')}
						</Button>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-key`}>
							{t(mcpPrefix + 'gatewayKey')}
						</FieldLabel>
						<NativeSelect
							id={`${id}-key`}
							className='w-full'
							value={state.key?.id ?? ''}
							disabled={state.loadingKeys}
							onChange={(event) => state.selectKey(event.target.value)}
						>
							<NativeSelectOption value=''>—</NativeSelectOption>
							{state.keys.map((key) => (
								<NativeSelectOption key={key.id} value={key.id}>
									{key.user_email ?? key.user_id} · {key.name ?? key.id} ·{' '}
									{key.status}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<McpField
						label='keySecret'
						value={state.secret}
						onChange={state.setSecret}
						type='password'
						maxLength={4096}
						hint='keyHint'
					/>
					<Field>
						<FieldLabel htmlFor={`${id}-method`}>
							{t(mcpPrefix + 'method')}
						</FieldLabel>
						<NativeSelect
							id={`${id}-method`}
							className='w-full'
							value={state.method}
							onChange={(event) =>
								state.setMethod(event.target.value as McpClientMethod)
							}
						>
							{MCP_CLIENT_METHODS.map((method) => (
								<NativeSelectOption key={method} value={method}>
									{method}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-version`}>
							{t(mcpPrefix + 'version')}
						</FieldLabel>
						<NativeSelect
							id={`${id}-version`}
							className='w-full'
							value={state.version}
							onChange={(event) => state.setVersion(event.target.value)}
						>
							{MCP_CLIENT_VERSIONS.map((version) => (
								<NativeSelectOption key={version} value={version}>
									{version}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
				</FieldGroup>
				<div className='flex flex-wrap items-center gap-3'>
					<Button
						variant='outline'
						disabled={state.loadingKeys || state.page <= 1}
						onClick={() => void state.loadKeys(state.page - 1)}
					>
						{t(mcpPrefix + 'previous')}
					</Button>
					<span className='text-sm'>
						{t(mcpPrefix + 'page', { page: state.page })}
					</span>
					<Button
						variant='outline'
						disabled={state.loadingKeys || state.page * 100 >= state.total}
						onClick={() => void state.loadKeys(state.page + 1)}
					>
						{t(mcpPrefix + 'next')}
					</Button>
				</div>
				<div className='flex flex-wrap gap-3'>
					<Button onClick={() => void state.send()} disabled={!state.canSend}>
						{t(mcpPrefix + 'send')}
					</Button>
					<Button
						variant='outline'
						onClick={state.stop}
						disabled={!state.pending}
					>
						{t(mcpPrefix + 'stop')}
					</Button>
					<Button
						variant='outline'
						disabled={!state.request}
						onClick={() => void copy()}
					>
						{t(mcpPrefix + 'copyCurl')}
					</Button>
					{copied && (
						<span role='status' className='text-muted-foreground text-sm'>
							{t(mcpPrefix + copied)}
						</span>
					)}
				</div>
				{state.error && (
					<McpNotice
						message={state.error}
						destructive={state.error !== 'cancelled'}
					/>
				)}
				{state.request && (
					<McpJson
						value={{
							url: state.request.url,
							headers: state.request.headers,
							body: JSON.parse(state.request.bodyText),
						}}
						label='request'
					/>
				)}
				{state.diagnostic && (
					<McpClientResponse
						diagnostic={state.diagnostic}
						response={state.response}
						servers={props.servers}
					/>
				)}
			</CardContent>
		</Card>
	)
}
