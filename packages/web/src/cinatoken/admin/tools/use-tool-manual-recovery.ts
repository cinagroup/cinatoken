/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { toolErrorKey } from './tools-errors'
import {
	inspectToolRecovery,
	acknowledgeToolRecovery,
	type ToolRecoveryEvidence,
} from './tools-manual'
import type { ToolMarker } from './tools-marker'
import type { AdminToolsProps, ToolsManager } from './use-admin-tools'

export function useToolManualRecovery(props: {
	context: AdminToolsProps
	manager: ToolsManager
	marker: ToolMarker
	onRecovered: () => void
}) {
	const [evidence, setEvidence] = useState<ToolRecoveryEvidence | null>(null),
		[ack, setAck] = useState(false),
		[busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null),
		[cursors, setCursors] = useState<Array<string | null>>([null])
	const active = useRef(true),
		controller = useRef<AbortController | null>(null)
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
		}
	}, [])
	async function run(
		kind: 'inspect' | 'ack' | 'page',
		cursor: string | null = null,
		back = false
	) {
		if (controller.current) return
		const abort = new AbortController()
		controller.current = abort
		setBusy(true)
		setError(null)
		setAck(false)
		const options = {
			signal: abort.signal,
			expectedConsoleSubject: props.context.consoleSubject,
		}
		try {
			if (kind === 'inspect') {
				const value = await inspectToolRecovery(
					props.context.api,
					props.manager.stores.write,
					props.manager.identity,
					props.marker,
					options
				)
				if (active.current && !abort.signal.aborted) {
					setEvidence(value)
					setCursors([null])
				}
			}
			if (kind === 'page' && evidence) {
				const audit = await props.context.api.adminToolAudit(
					props.marker.family,
					cursor,
					options
				)
				if (active.current && !abort.signal.aborted) {
					setEvidence({ ...evidence, audit })
					setCursors((current) =>
						back ? current.slice(0, -1) : [...current, cursor]
					)
				}
			}
			if (kind === 'ack' && evidence) {
				await acknowledgeToolRecovery(
					props.context.api,
					props.manager.stores.write,
					props.manager.identity,
					props.marker,
					evidence,
					ack,
					options
				)
				if (active.current && !abort.signal.aborted) props.onRecovered()
			}
		} catch (failure) {
			if (active.current && !abort.signal.aborted) {
				setEvidence(null)
				setError(toolErrorKey(failure))
				props.manager.accessLost('read', failure)
			}
		} finally {
			if (active.current) {
				controller.current = null
				setBusy(false)
			}
		}
	}
	return { evidence, ack, setAck, busy, error, cursors, run }
}
