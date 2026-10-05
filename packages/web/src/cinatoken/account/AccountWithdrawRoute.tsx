import { cinatokenApi } from '../api'
import { AccountWithdraw } from './withdraw/AccountWithdraw'

export function AccountWithdrawRoute() {
	return <AccountWithdraw api={cinatokenApi} />
}
