/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

const prefix = 'cinatoken.adminModelAnalytics.'
export function AnalyticsDrilldownControls(props: {
	count: number
	onCollapse: () => void
}) {
	const { t } = useTranslation()
	return (
		<div className='flex flex-wrap items-center justify-between gap-2'>
			<p role='status' className='text-muted-foreground text-sm'>
				{t(prefix + 'drilldownExpanded', { count: props.count })}
			</p>
			<Button
				type='button'
				size='sm'
				variant='outline'
				disabled={props.count === 0}
				onClick={props.onCollapse}
			>
				{t(prefix + 'collapseDetails')}
			</Button>
		</div>
	)
}
