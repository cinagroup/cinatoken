import { cinatokenApi } from '../api'
import { AccountGuardrails } from './guardrails/AccountGuardrails'

export function AccountGuardrailsRoute() {
	return <AccountGuardrails api={cinatokenApi} />
}
