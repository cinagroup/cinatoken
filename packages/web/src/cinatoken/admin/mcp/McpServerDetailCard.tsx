/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import { McpJson, McpNotice, McpStatus, mcpPrefix } from './McpFields'
import { McpLastSync } from './McpLastSync'
import { McpPricingDetails } from './McpPricingFields'
import type {
	McpServer,
	McpConnectionTest,
	McpSyncSummary,
	McpSecrets,
} from './mcp-contracts'
import { mcpInvocationHref } from './mcp-domain'

export function McpServerDetailCard(props: {
	server: McpServer
	writeAllowed: boolean
	busy: boolean
	secrets: McpSecrets | null
	currency: 'USD' | 'CNY' | null
	timezone?: string | null
	test: McpConnectionTest | null
	sync: McpSyncSummary | null
	onEdit: () => void
	onTest: () => void
	onSync: () => void
	onToggle: () => void
	onDelete: () => void
	onReveal: () => void
}) {
	const { t } = useTranslation()
	const server = props.server
	return (
		<Card className='min-w-0'>
			<CardHeader>
				<div className='flex flex-wrap items-start justify-between gap-3'>
					<div className='flex min-w-0 flex-col gap-2'>
						<CardTitle className='break-all'>{server.name}</CardTitle>
						<CardDescription className='font-mono break-all'>
							{server.slug}
						</CardDescription>
					</div>
					<McpStatus status={server.status} />
				</div>
			</CardHeader>
			<CardContent className='flex min-w-0 flex-col gap-4'>
				{server.description && (
					<p className='text-muted-foreground text-sm break-words whitespace-pre-wrap'>
						{server.description}
					</p>
				)}
				<div className='flex flex-wrap gap-2'>
					<Button
						variant='outline'
						disabled={!props.writeAllowed}
						onClick={() => props.onEdit()}
					>
						{t(mcpPrefix + 'edit')}
					</Button>
					<Button
						variant='outline'
						disabled={!props.writeAllowed}
						onClick={() => props.onTest()}
					>
						{t(mcpPrefix + 'test')}
					</Button>
					<Button disabled={!props.writeAllowed} onClick={() => props.onSync()}>
						{t(mcpPrefix + 'sync')}
					</Button>
					<Button
						variant='outline'
						disabled={!props.writeAllowed}
						onClick={() => props.onToggle()}
					>
						{t(mcpPrefix + (server.status === 'active' ? 'disable' : 'enable'))}
					</Button>
					<Button
						variant='destructive'
						disabled={!props.writeAllowed}
						onClick={() => props.onDelete()}
					>
						{t(mcpPrefix + 'delete')}
					</Button>
				</div>
				<McpLastSync value={server.lastSyncedAt} timezone={props.timezone} />
				{server.lastSyncError && <McpNotice message='syncError' destructive />}
				{props.test && (
					<Alert>
						<AlertDescription>
							{t(mcpPrefix + 'tested', {
								version: props.test.protocolVersion,
								tools: props.test.counts.tools,
								prompts: props.test.counts.prompts,
								resources: props.test.counts.resources,
							})}
						</AlertDescription>
					</Alert>
				)}
				{props.sync && (
					<Alert>
						<AlertDescription>
							{t(mcpPrefix + 'synced', {
								added: props.sync.added.length,
								changed: props.sync.changed.length,
								removed: props.sync.removed.length,
								unchanged: props.sync.unchanged,
							})}
						</AlertDescription>
					</Alert>
				)}
				<a
					href={mcpInvocationHref(server.slug)}
					className='text-primary self-start text-sm underline-offset-2 hover:underline'
				>
					{t(mcpPrefix + 'invocations')}
				</a>
				<details className='min-w-0 rounded-lg border p-4'>
					<summary className='cursor-pointer text-sm font-medium'>
						{t(mcpPrefix + 'connection')}
					</summary>
					<div className='mt-4 flex min-w-0 flex-col gap-4'>
						<dl className='flex min-w-0 flex-col gap-3 text-sm'>
							<div>
								<dt className='text-muted-foreground'>
									{t(mcpPrefix + 'url')}
								</dt>
								<dd className='mt-1 font-mono text-xs break-all'>
									{props.secrets?.url ?? server.urlMasked}
								</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(mcpPrefix + 'headers')}
								</dt>
								<dd className='mt-1 font-mono text-xs break-all'>
									{server.authHeaderNames.join(', ') ||
										t(mcpPrefix + 'noSecrets')}
								</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(mcpPrefix + 'timeout')}
								</dt>
								<dd>{server.timeoutMs}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(mcpPrefix + 'maxBytes')}
								</dt>
								<dd>{server.maxResponseBytes}</dd>
							</div>
						</dl>
						<Button
							variant='outline'
							className='self-start'
							disabled={props.busy}
							onClick={() => void props.onReveal()}
						>
							{t(mcpPrefix + (props.secrets ? 'hide' : 'reveal'))}
						</Button>
						{props.secrets && (
							<>
								<p className='text-muted-foreground text-xs'>
									{t(mcpPrefix + 'revealHint')}
								</p>
								<pre className='bg-muted max-h-64 overflow-auto rounded-lg p-3 text-xs break-all whitespace-pre-wrap'>
									{JSON.stringify(props.secrets.authHeaders, null, 2)}
								</pre>
							</>
						)}
						<h3 className='font-medium'>{t(mcpPrefix + 'defaultPricing')}</h3>
						<McpPricingDetails
							rule={server.pricing}
							currency={props.currency}
						/>
						{props.test && (
							<McpJson value={props.test.serverInfo} label='details' />
						)}
					</div>
				</details>
			</CardContent>
		</Card>
	)
}
