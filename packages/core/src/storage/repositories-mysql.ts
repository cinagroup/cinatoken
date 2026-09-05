import type { GatewayDatabaseClient } from "./database-client";
import type { GatewayRepositories } from "./repositories-types";
import { createMySqlAdminAnalyticsRepository } from "../db/mysql/admin-analytics.impl";
import { createMySqlBatchesRepository } from "../db/mysql/batches.impl";
import { createMySqlApiKeysRepository } from "../db/mysql/api-keys.impl";
import { createMySqlModelRoutesRepository } from "../db/mysql/model-routes.impl";
import { createMySqlModelRoutingRepository } from "../db/mysql/model-routing.impl";
import { createMySqlModelsRepository } from "../db/mysql/models.impl";
import { createMySqlProvidersRepository } from "../db/mysql/providers.impl";
import { createMySqlRequestLogsRepository } from "../db/mysql/request-logs.impl";
import { createMySqlSystemConfigRepository } from "../db/mysql/system-config.impl";
import { createMySqlRoutePoolStickyBindingsRepository } from "../db/mysql/route-pool-sticky-bindings.impl";
import { createMySqlUserAuditLogsRepository } from "../db/mysql/user-audit-logs.impl";
import { createMySqlUsersRepository } from "../db/mysql/users.impl";
import { createMySqlAdminAccessRepository } from "../db/mysql/admin-access.impl";
import { createMySqlRequestPresetsRepository } from "../db/mysql/request-presets.impl";
import { createMySqlGuardrailsRepository } from "../db/mysql/guardrails.impl";
import { createMySqlGuardrailBudgetsRepository } from "../db/mysql/guardrail-budgets.impl";
import { createMySqlUserBudgetReservationsRepository } from "../db/mysql/user-budget-reservations.impl";
import { createMySqlRouteDataPoliciesRepository } from "../db/mysql/route-data-policies.impl";
import { createMySqlModelEndpointsRepository } from "../db/mysql/model-endpoints.impl";
import { createManagementApiKeysRepository } from "./management-api-keys";
import { createByokKeysRepository } from "./byok-keys";
import {
	createMySqlPortalAccessRepository,
	createMySqlPortalLedgerRepository,
	createMySqlSharedKeysRepository,
} from "../db/mysql/portal-marketplace.impl";

export function createMySqlRepositories(
	client: GatewayDatabaseClient
): GatewayRepositories {
	if (client.driver !== "mysql") {
		throw new Error("createMySqlRepositories: expected MySQL client");
	}
	return {
		client,
		batches: createMySqlBatchesRepository(client),
		users: createMySqlUsersRepository(client),
		apiKeys: createMySqlApiKeysRepository(client),
		requestLogs: createMySqlRequestLogsRepository(client),
		requestPresets: createMySqlRequestPresetsRepository(client),
		guardrails: createMySqlGuardrailsRepository(client),
		guardrailBudgets: createMySqlGuardrailBudgetsRepository(client),
		userBudgets: createMySqlUserBudgetReservationsRepository(client),
		routeDataPolicies: createMySqlRouteDataPoliciesRepository(client),
		modelEndpoints: createMySqlModelEndpointsRepository(client),
		managementApiKeys: createManagementApiKeysRepository(client),
		byokKeys: createByokKeysRepository(client),
		providers: createMySqlProvidersRepository(client),
		models: createMySqlModelsRepository(client),
		routes: createMySqlModelRoutesRepository(client),
		systemConfig: createMySqlSystemConfigRepository(client),
		analytics: createMySqlAdminAnalyticsRepository(client),
		modelRouting: createMySqlModelRoutingRepository(client),
		userAuditLogs: createMySqlUserAuditLogsRepository(client),
		routePoolSticky: createMySqlRoutePoolStickyBindingsRepository(client),
		adminAccess: createMySqlAdminAccessRepository(client),
		portalAccess: createMySqlPortalAccessRepository(client),
		sharedKeys: createMySqlSharedKeysRepository(client),
		portalLedger: createMySqlPortalLedgerRepository(client),
	};
}
