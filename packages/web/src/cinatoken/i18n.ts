/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import { workspaceBudgetMessages } from './account/budgets/messages'
import { earningsMessages } from './account/earnings/messages'
import { guardrailMessages } from './account/guardrails/messages'
import { accountMessages } from './account/messages'
import { nftMessages } from './account/nft/messages'
import { overviewContributionMessages } from './account/overview-messages'
import { presetsMessages } from './account/presets/messages'
import { settingsMessages } from './account/settings-messages'
import { withdrawalMessages } from './account/withdraw/messages'
import { adminAccessKeyMessages } from './admin/access-keys/messages'
import { adminModelAnalyticsMessages } from './admin/analytics/models/messages'
import { adminProviderAnalyticsMessages } from './admin/analytics/providers/messages'
import { adminUserAnalyticsMessages } from './admin/analytics/users/messages'
import { adminAuditLogMessages } from './admin/audit-logs/messages'
import { chainOperationsMessages } from './admin/chain-operations/messages'
import {
	configFullMessages,
	configTimezoneMessages,
} from './admin/config/messages'
import { dashboardMessages } from './admin/dashboard/messages'
import { dataPolicyMessages } from './admin/data-policies/messages'
import { adminDomainMessages } from './admin/domain-messages'
import { endpointMessages } from './admin/endpoints/messages'
import { adminGatewayKeyMessages } from './admin/gateway-keys/messages'
import { adminGuardrailMessages } from './admin/guardrails/messages'
import { consoleMessages } from './admin/messages'
import { adminModelsMessages } from './admin/models/messages'
import { playgroundMessages } from './admin/playground/playground-messages'
import { adminPresetMessages } from './admin/presets/messages'
import { providerMessages } from './admin/providers/messages'
import { adminReliabilityMessages } from './admin/reliability/messages'
import { adminRequestLogMessages } from './admin/request-logs/messages'
import { routeMessages } from './admin/routes/messages'
import { adminSharedKeyMessages } from './admin/shared-keys/messages'
import { adminSimulatorMessages } from './admin/simulator/simulator-messages'
import { adminToolInvocationMessages } from './admin/tool-invocations/messages'
import { adminToolMessages } from './admin/tools/messages'
import { adminUserDetailMessages } from './admin/user-detail/messages'
import { adminUsersMessages } from './admin/users/messages'
import { chatMessages } from './chat/messages'
import { publicAuthMessages } from './public/auth/messages'
import { publicHomeMessages } from './public/home/home-messages'
import { publicMessages } from './public/messages'
import { shellMessages } from './shell-messages'

void i18n
	.use(LanguageDetector)
	.use(initReactI18next)
	.init({
		resources: Object.fromEntries(
			Object.entries(shellMessages).map(([locale, shell]) => [
				locale,
				{
					translation: {
						cinatoken: {
							shell,
							home: publicHomeMessages[
								locale as keyof typeof publicHomeMessages
							],
							chat: chatMessages[locale as keyof typeof chatMessages],
							public: publicMessages[locale as keyof typeof publicMessages],
							publicAuth:
								publicAuthMessages[locale as keyof typeof publicAuthMessages],
							console: consoleMessages[locale as keyof typeof consoleMessages],
							adminChainOperations:
								chainOperationsMessages[
									locale as keyof typeof chainOperationsMessages
								],
							adminProviders:
								providerMessages[locale as keyof typeof providerMessages],
							adminDomain:
								adminDomainMessages[locale as keyof typeof adminDomainMessages],
							adminModels:
								adminModelsMessages[locale as keyof typeof adminModelsMessages],
							adminEndpoints:
								endpointMessages[locale as keyof typeof endpointMessages],
							adminRoutes: routeMessages[locale as keyof typeof routeMessages],
							adminDataPolicies:
								dataPolicyMessages[locale as keyof typeof dataPolicyMessages],
							adminDashboard:
								dashboardMessages[locale as keyof typeof dashboardMessages],
							adminReliability:
								adminReliabilityMessages[
									locale as keyof typeof adminReliabilityMessages
								],
							adminModelAnalytics:
								adminModelAnalyticsMessages[
									locale as keyof typeof adminModelAnalyticsMessages
								],
							adminProviderAnalytics:
								adminProviderAnalyticsMessages[
									locale as keyof typeof adminProviderAnalyticsMessages
								],
							adminUserAnalytics:
								adminUserAnalyticsMessages[
									locale as keyof typeof adminUserAnalyticsMessages
								],
							adminRequestLogs:
								adminRequestLogMessages[
									locale as keyof typeof adminRequestLogMessages
								],
							adminAccessKeys:
								adminAccessKeyMessages[
									locale as keyof typeof adminAccessKeyMessages
								],
							adminGatewayKeys:
								adminGatewayKeyMessages[
									locale as keyof typeof adminGatewayKeyMessages
								],
							adminSharedKeys:
								adminSharedKeyMessages[
									locale as keyof typeof adminSharedKeyMessages
								],
							adminTools:
								adminToolMessages[locale as keyof typeof adminToolMessages],
							admin: {
								playground:
									playgroundMessages[locale as keyof typeof playgroundMessages],
							},
							adminSimulator:
								adminSimulatorMessages[
									locale as keyof typeof adminSimulatorMessages
								],
							adminToolInvocations:
								adminToolInvocationMessages[
									locale as keyof typeof adminToolInvocationMessages
								],
							adminAuditLogs:
								adminAuditLogMessages[
									locale as keyof typeof adminAuditLogMessages
								],
							adminUsers:
								adminUsersMessages[locale as keyof typeof adminUsersMessages],
							adminUserDetail:
								adminUserDetailMessages[
									locale as keyof typeof adminUserDetailMessages
								],
							adminPresets:
								adminPresetMessages[locale as keyof typeof adminPresetMessages],
							adminGuardrails:
								adminGuardrailMessages[
									locale as keyof typeof adminGuardrailMessages
								],
							adminConfigTimezone:
								configTimezoneMessages[
									locale as keyof typeof configTimezoneMessages
								],
							adminConfigFull:
								configFullMessages[locale as keyof typeof configFullMessages],
							account: {
								...accountMessages[locale as keyof typeof accountMessages],
								earnings:
									earningsMessages[locale as keyof typeof earningsMessages],
								nft: nftMessages[locale as keyof typeof nftMessages],
								contribution:
									overviewContributionMessages[
										locale as keyof typeof overviewContributionMessages
									],
								guardrails:
									guardrailMessages[locale as keyof typeof guardrailMessages],
								settings:
									settingsMessages[locale as keyof typeof settingsMessages],
								withdraw:
									withdrawalMessages[locale as keyof typeof withdrawalMessages],
							},
							workspaceBudgets:
								workspaceBudgetMessages[
									locale as keyof typeof workspaceBudgetMessages
								],
							presets: presetsMessages[locale as keyof typeof presetsMessages],
						},
					},
				},
			])
		),
		fallbackLng: 'en',
		supportedLngs: ['en', 'zh', 'ja', 'ko'],
		load: 'languageOnly',
		interpolation: { escapeValue: false },
		detection: {
			order: ['cookie', 'localStorage', 'navigator'],
			lookupCookie: 'NEXT_LOCALE',
			lookupLocalStorage: 'cinatoken-language',
			caches: ['localStorage'],
		},
	})

i18n.on('languageChanged', (language) => {
	document.documentElement.lang = language
	document.cookie = `NEXT_LOCALE=${encodeURIComponent(language)}; Path=/; SameSite=Lax; Max-Age=31536000`
})
document.documentElement.lang = i18n.resolvedLanguage ?? 'en'

export default i18n
