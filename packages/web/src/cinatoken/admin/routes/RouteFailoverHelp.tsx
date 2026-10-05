/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'

const prefix = 'cinatoken.adminRoutes.failover-'
export function RouteFailoverHelp() {
	const { t } = useTranslation()
	return (
		<details className='rounded-xl border p-4'>
			<summary className='cursor-pointer text-sm font-medium'>
				{t(prefix + 'title')}
			</summary>
			<p className='text-muted-foreground mt-2 text-xs'>
				{t(prefix + 'readonlyHint')}
			</p>
			<ol className='mt-3 list-decimal space-y-2 pl-5 text-sm'>
				{[
					'order',
					'sameLayer',
					'crossLayer',
					'attemptLimit',
					'circuitCooldown',
					'allBusy',
					'memoryNote',
					'imagesAbort',
				].map((key) => (
					<li key={key}>{t(prefix + key)}</li>
				))}
			</ol>
		</details>
	)
}
