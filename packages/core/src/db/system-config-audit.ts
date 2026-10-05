import { ALERT_WEBHOOK_FEISHU_URL_KEY, ALERT_WEBHOOK_WECOM_URL_KEY } from '../lib/alert-webhook-system-config';
import type { SystemConfigAuditWrite } from '../storage/gateway-repository-interfaces';

// The generic Admin PUT accepts arbitrary keys, including secret-shaped strings.
// Only keys explicitly owned by the current config code or seeded migrations may be stored in audit rows.
const AUDITABLE_CONFIG_KEYS = new Set([
	'BUSINESS_TIMEZONE', 'BILLING_CURRENCY', 'ROUTE_STRATEGY',
	ALERT_WEBHOOK_WECOM_URL_KEY, ALERT_WEBHOOK_FEISHU_URL_KEY,
	'WEB_SEARCH_PROVIDER', 'WEB_SEARCH_API_KEY', 'WEB_SEARCH_COST', 'WEB_SEARCH_ACTIVE', 'WEB_SEARCH_CATALOG',
	'WEB_FETCH_PROVIDER', 'WEB_FETCH_API_KEY', 'WEB_FETCH_COST', 'WEB_FETCH_ACTIVE', 'WEB_FETCH_CATALOG',
	'WEB_DEEP_SEARCH_ACTIVE', 'WEB_DEEP_SEARCH_CATALOG',
	'AI_DETECTION_ACTIVE', 'AI_DETECTION_CATALOG',
	'SHARED_KEY_ENABLED_CHANNELS', 'SHARED_KEY_COMMISSION_RATE',
	'SHARED_KEY_MAX_INPUT_PRICE', 'SHARED_KEY_MAX_OUTPUT_PRICE',
	'WITHDRAWAL_MIN_AMOUNT', 'WITHDRAWAL_FEE', 'WITHDRAWAL_CINACREDIT_RATE', 'WITHDRAWAL_DAILY_LIMIT',
	'NFT_TIER_THRESHOLDS',
]);

/** Never derive audit fields by serializing the config value or a request body. */
export function configAuditMetadata(input: SystemConfigAuditWrite) {
	const channel = input.key === ALERT_WEBHOOK_WECOM_URL_KEY
		? 'wecom'
		: input.key === ALERT_WEBHOOK_FEISHU_URL_KEY ? 'feishu' : null;
	return {
		configKey: AUDITABLE_CONFIG_KEYS.has(input.key) ? input.key : '[nonstandard]',
		channel,
		action: input.value.trim() === '' ? 'clear' : 'set',
	} as const;
}
