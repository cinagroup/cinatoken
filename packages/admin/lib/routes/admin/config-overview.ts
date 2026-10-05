import type { GatewayRepositories } from "@octafuse/core";
import {
	DEFAULT_BILLING_CURRENCY,
	normalizeBillingCurrencyCode,
	tryParseBillingCurrencyInput,
} from "@octafuse/core/lib/billing-currency";
import { resolveBusinessTimezoneConfiguration } from "@octafuse/core/lib/business-timezone";
import {
	DEFAULT_ROUTE_STRATEGY,
	isRouteStrategyName,
} from "@octafuse/core/db/model-route-policy";
import { ROUTE_STRATEGY_KEY } from "@octafuse/core/lib/route-strategy-system-config";
import {
	ALERT_WEBHOOK_FEISHU_URL_KEY,
	ALERT_WEBHOOK_WECOM_URL_KEY,
} from "@octafuse/core/lib/alert-webhook-system-config";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { hasAdminPermission } from "@/lib/admin-principal";

type ConfigSource = "configured" | "missing" | "invalid";

function billingCurrency(raw: string | null): {
	value: string;
	source: ConfigSource | "unsupported";
} {
	const value = normalizeBillingCurrencyCode(raw);
	if (!(raw ?? "").trim())
		return { value: DEFAULT_BILLING_CURRENCY, source: "missing" };
	const parsed = tryParseBillingCurrencyInput(raw);
	if (!parsed) return { value: DEFAULT_BILLING_CURRENCY, source: "invalid" };
	return {
		value,
		source: value === "USD" || value === "CNY" ? "configured" : "unsupported",
	};
}

function routeStrategy(raw: string | null): {
	value: string;
	source: ConfigSource;
} {
	const normalized = (raw ?? "").trim().toLowerCase();
	if (isRouteStrategyName(normalized))
		return { value: normalized, source: "configured" };
	return {
		value: DEFAULT_ROUTE_STRATEGY,
		source: normalized ? "invalid" : "missing",
	};
}

/** A fixed-key projection for browser state; raw webhook URLs never leave this function. */
export async function loadAdminConfigOverview(
	repos: GatewayRepositories,
	principal: AdminPrincipal
) {
	const [timezoneRow, currencyRow, strategyRow, wecomRow, feishuRow] =
		await Promise.all([
			repos.systemConfig.getConfigSnapshot("BUSINESS_TIMEZONE"),
			repos.systemConfig.getConfigSnapshot("BILLING_CURRENCY"),
			repos.systemConfig.getConfigSnapshot(ROUTE_STRATEGY_KEY),
			repos.systemConfig.getConfigSnapshot(ALERT_WEBHOOK_WECOM_URL_KEY),
			repos.systemConfig.getConfigSnapshot(ALERT_WEBHOOK_FEISHU_URL_KEY),
		]);
	const timezone = resolveBusinessTimezoneConfiguration(timezoneRow.value);
	return {
		businessTimezone: {
			value: timezone.businessTimezone,
			source: timezone.source,
			revision: timezoneRow.revision,
		},
		billingCurrency: {
			...billingCurrency(currencyRow.value),
			revision: currencyRow.revision,
		},
		routeStrategy: {
			...routeStrategy(strategyRow.value),
			revision: strategyRow.revision,
		},
		webhooks: {
			wecom: {
				configured: Boolean(wecomRow.value?.trim()),
				revision: wecomRow.revision,
			},
			feishu: {
				configured: Boolean(feishuRow.value?.trim()),
				revision: feishuRow.revision,
			},
		},
		canWrite: hasAdminPermission(principal, "config.write"),
		canReveal: hasAdminPermission(principal, "config.secrets.read"),
	};
}
