/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { McpClientCatalog } from './McpClientCatalog'
import { mcpPrefix } from './McpFields'
import type { executeMcpClient, McpClientDiagnostic } from './mcp-client'
import { mcpClientResponseView } from './mcp-client-catalog'
import { MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT } from './mcp-client-diagnostics'
import type { McpServerSummary } from './mcp-contracts'

export function McpClientResponse(props: {
	diagnostic: McpClientDiagnostic
	response: Awaited<ReturnType<typeof executeMcpClient>> | null
	servers: McpServerSummary[]
}) {
	const { t, i18n } = useTranslation()
	const [view, setView] = useState<'raw' | 'grouped'>('raw')
	const [copied, setCopied] = useState<'copied' | 'copyFailed' | null>(null)
	const [previousDiagnostic, setPreviousDiagnostic] = useState(props.diagnostic)
	if (previousDiagnostic !== props.diagnostic) {
		setPreviousDiagnostic(props.diagnostic)
		setCopied(null)
	}
	const copyOwner = useRef<object | null>(null)
	useLayoutEffect(() => {
		copyOwner.current = {}
		return () => {
			copyOwner.current = null
		}
	}, [props.diagnostic])
	const entries = props.response?.parsed.valid
		? props.response.parsed.entries
		: null
	const responseView = mcpClientResponseView(view, entries)
	const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language)
	let bodyText = props.diagnostic.bodyText || t(mcpPrefix + 'clientEmptyBody')
	if (props.diagnostic.bodyText === null)
		bodyText = t(mcpPrefix + 'clientBodyUnavailable')
	async function copy(): Promise<void> {
		if (props.diagnostic.bodyText === null) return
		const owner = {}
		copyOwner.current = owner
		try {
			await navigator.clipboard.writeText(props.diagnostic.bodyText)
			if (owner && owner === copyOwner.current) setCopied('copied')
		} catch {
			if (owner && owner === copyOwner.current) setCopied('copyFailed')
		}
	}
	return (
		<section
			aria-label={t(mcpPrefix + 'response')}
			className='flex min-w-0 flex-col gap-4'
		>
			{props.response?.parsed.valid && (
				<Alert>
					<AlertDescription>
						{t(mcpPrefix + 'clientSuccess', {
							status: props.diagnostic.status,
							ms: props.diagnostic.elapsedMs,
						})}
					</AlertDescription>
				</Alert>
			)}
			<dl className='grid min-w-0 grid-cols-2 gap-3 text-sm'>
				<div>
					<dt className='text-muted-foreground'>
						{t(mcpPrefix + 'clientHttpStatus')}
					</dt>
					<dd className='mt-1 font-mono'>
						{props.diagnostic.status ?? t(mcpPrefix + 'clientNoStatus')}
					</dd>
				</div>
				<div>
					<dt className='text-muted-foreground'>
						{t(mcpPrefix + 'clientElapsed')}
					</dt>
					<dd className='mt-1 font-mono'>
						{t(mcpPrefix + 'clientMilliseconds', {
							value: number.format(props.diagnostic.elapsedMs),
						})}
					</dd>
				</div>
			</dl>
			<details className='min-w-0 rounded-lg border p-3'>
				<summary className='cursor-pointer text-sm'>
					{t(mcpPrefix + 'clientResponseHeaders')}
				</summary>
				<p className='text-muted-foreground mt-2 text-xs'>
					{t(mcpPrefix + 'clientHeadersHint')}
				</p>
				{Object.keys(props.diagnostic.headers).length > 0 ? (
					<pre className='mt-2 max-h-48 overflow-auto text-xs break-all whitespace-pre-wrap'>
						{JSON.stringify(props.diagnostic.headers, null, 2)}
					</pre>
				) : (
					<p className='text-muted-foreground mt-2 text-sm'>
						{t(mcpPrefix + 'clientNoHeaders')}
					</p>
				)}
			</details>
			<div className='flex flex-wrap items-center gap-3'>
				<ToggleGroup
					variant='outline'
					aria-label={t(mcpPrefix + 'response')}
					value={[responseView]}
					onValueChange={(values) => {
						if (values[0] === 'raw' || values[0] === 'grouped')
							setView(values[0])
					}}
				>
					<ToggleGroupItem value='raw'>
						{t(mcpPrefix + 'clientResponseBody')}
					</ToggleGroupItem>
					<ToggleGroupItem value='grouped' disabled={entries === null}>
						{t(mcpPrefix + 'grouped')}
					</ToggleGroupItem>
				</ToggleGroup>
				<Button
					variant='outline'
					disabled={props.diagnostic.bodyText === null}
					onClick={() => void copy()}
				>
					{t(mcpPrefix + 'copyResponse')}
				</Button>
				{copied && (
					<span role='status' className='text-muted-foreground text-sm'>
						{t(mcpPrefix + copied)}
					</span>
				)}
			</div>
			<p className='text-muted-foreground text-xs'>
				{t(mcpPrefix + 'clientCopyHint')}
			</p>
			{props.diagnostic.truncated && (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(mcpPrefix + 'clientBodyTruncated', {
						limit: number.format(MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT),
					})}
				</p>
			)}
			{responseView === 'grouped' && props.response ? (
				<McpClientCatalog
					key={props.response.request.bodyText}
					entries={entries ?? []}
					method={props.response.request.rpcMethod}
					slug={props.response.request.slug}
					servers={props.servers}
				/>
			) : (
				<pre
					aria-label={t(mcpPrefix + 'clientResponseBody')}
					className='bg-muted max-h-96 overflow-auto rounded-lg p-3 text-xs break-all whitespace-pre-wrap'
				>
					{bodyText}
				</pre>
			)}
		</section>
	)
}
