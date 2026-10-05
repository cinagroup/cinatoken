/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */

export function KpiCard(props: {
	label: string
	value: string
	hint?: string
	emphasis?: 'normal' | 'danger'
}) {
	return (
		<article className='bg-card min-w-0 rounded-xl border p-4 shadow-sm sm:p-5'>
			<p className='text-muted-foreground text-sm'>{props.label}</p>
			<p
				className={`mt-2 text-2xl font-semibold tracking-tight break-words ${
					props.emphasis === 'danger' ? 'text-destructive' : ''
				}`}
			>
				{props.value}
			</p>
			{props.hint ? (
				<p className='text-muted-foreground mt-2 text-xs break-words'>
					{props.hint}
				</p>
			) : null}
		</article>
	)
}
