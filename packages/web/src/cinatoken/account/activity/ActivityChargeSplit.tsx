import type { ActivityLog } from '../../activity-contracts'
import { RequestChargeSplit } from '../../admin/request-logs/RequestChargeSplit'

/** The Activity response confirms the main-unit currency and recorded list snapshot. */
export function ActivityChargeSplit(props: {
	log: Pick<ActivityLog, 'chargedCost' | 'chargedWalletCost'>
	currency: string
	compact?: boolean
}) {
	return (
		<RequestChargeSplit
			log={{
				charged_cost: props.log.chargedCost,
				charged_wallet_cost: props.log.chargedWalletCost,
			}}
			currency={props.currency}
			compact={props.compact}
		/>
	)
}
