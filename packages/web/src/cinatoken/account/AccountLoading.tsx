import { useTranslation } from 'react-i18next'
import { Skeleton } from '@/components/ui/skeleton'

export function AccountLoading() {
	const { t } = useTranslation()
	return (
		<div
			className='space-y-5'
			role='status'
			aria-label={t('cinatoken.account.loading')}
		>
			<span className='sr-only'>{t('cinatoken.account.loading')}</span>
			<Skeleton className='h-9 w-64' />
			<Skeleton className='h-4 w-80 max-w-full' />
			<div className='grid gap-4 sm:grid-cols-3'>
				{[0, 1, 2].map((index) => (
					<Skeleton key={index} className='h-28' />
				))}
			</div>
			<Skeleton className='h-64' />
		</div>
	)
}
