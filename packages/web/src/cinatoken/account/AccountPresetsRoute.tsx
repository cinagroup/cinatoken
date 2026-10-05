import { cinatokenApi } from '../api'
import { AccountPresets } from './presets/AccountPresets'

export function AccountPresetsRoute() {
	return <AccountPresets api={cinatokenApi} />
}
