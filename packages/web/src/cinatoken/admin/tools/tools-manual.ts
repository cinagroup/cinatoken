/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { AdminToolsApi } from './tools-api'
import type { ToolProvider } from './tools-domain'
import { ToolPersistenceError, ToolSubjectError } from './tools-errors'
import type { ToolMarker } from './tools-marker'
import type { ToolWriteRecovery } from './tools-recovery'
import type { ToolBoundOptions } from './tools-subject'

export type ToolRecoveryEvidence = Awaited<
	ReturnType<typeof inspectToolRecovery>
>
function exactMarker(
	store: ToolWriteRecovery,
	identity: string,
	marker: ToolMarker,
	signal?: AbortSignal
): void {
	signal?.throwIfAborted()
	if (JSON.stringify(store.marker(identity)) !== JSON.stringify(marker))
		throw new ToolPersistenceError()
}
async function currentCapability(
	api: AdminToolsApi,
	marker: ToolMarker,
	options: ToolBoundOptions
) {
	const overview = await api.adminToolsOverview(options)
	options.signal?.throwIfAborted()
	const allowed =
		marker.operation === 'reveal'
			? overview.capabilities.can_reveal
			: overview.capabilities.can_write
	if (!allowed) throw new ToolSubjectError()
	return overview
}
export async function inspectToolRecovery(
	api: AdminToolsApi,
	store: ToolWriteRecovery,
	identity: string,
	marker: ToolMarker,
	options: ToolBoundOptions
) {
	exactMarker(store, identity, marker, options.signal)
	await api.verifyToolSubject(options)
	options.signal?.throwIfAborted()
	await currentCapability(api, marker, options)
	exactMarker(store, identity, marker, options.signal)
	const detail = await api.adminToolDetail(
		marker.family,
		marker.provider as ToolProvider,
		options
	)
	exactMarker(store, identity, marker, options.signal)
	if (
		!(marker.operation === 'reveal'
			? detail.capabilities.can_reveal
			: detail.capabilities.can_write)
	)
		throw new ToolSubjectError()
	const audit = await api.adminToolAudit(marker.family, null, options)
	exactMarker(store, identity, marker, options.signal)
	return { detail, audit, generation: marker.generation }
}
export async function acknowledgeToolRecovery(
	api: AdminToolsApi,
	store: ToolWriteRecovery,
	identity: string,
	marker: ToolMarker,
	evidence: ToolRecoveryEvidence,
	acknowledged: boolean,
	options: ToolBoundOptions
): Promise<void> {
	if (!acknowledged || evidence.generation !== marker.generation)
		throw new ToolPersistenceError()
	exactMarker(store, identity, marker, options.signal)
	await api.verifyToolSubject(options)
	exactMarker(store, identity, marker, options.signal)
	await currentCapability(api, marker, options)
	exactMarker(store, identity, marker, options.signal)
	await api.verifyToolSubject(options)
	exactMarker(store, identity, marker, options.signal)
	store.acknowledgeUnknown(identity, marker)
}
