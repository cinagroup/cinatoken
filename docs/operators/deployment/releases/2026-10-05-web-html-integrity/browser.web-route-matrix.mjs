export const PUBLIC_PAGES = [
  '/en', '/en/models', '/en/providers', '/en/compare', '/en/chat',
  '/en/rankings', '/en/benchmarks',
];
export const MISSING_MODEL_PATH = '/en/models/cinatoken-smoke-missing/no-such-model';
export const ACCOUNT_PAGES = [
  '/account', '/account/keys', '/account/byok', '/account/activity',
  '/account/earnings', '/account/nft', '/account/withdraw',
  '/account/presets', '/account/guardrails', '/account/settings',
];
export const ADMIN_FLAGS_AND_PAGES = [
  ['DASHBOARD', '/admin'],
  ['USERS', '/admin/users'],
  ['USER_DETAIL', '/admin/users/00000000-0000-4000-8000-000000000000'],
  ['PROVIDERS', '/admin/providers'],
  ['MODELS', '/admin/models'],
  ['ENDPOINTS', '/admin/endpoints'],
  ['ROUTES', '/admin/routes'],
  ['DATA_POLICIES', '/admin/data-policies'],
  ['PRESETS', '/admin/presets'],
  ['GUARDRAILS', '/admin/guardrails'],
  ['RELIABILITY', '/admin/analytics/reliability'],
  ['MODEL_ANALYTICS', '/admin/analytics/models'],
  ['PROVIDER_ANALYTICS', '/admin/analytics/providers'],
  ['USER_ANALYTICS', '/admin/analytics/users'],
  ['REQUEST_LOGS', '/admin/request-logs'],
  ['BUDGET_AUDIT', '/admin/audit-logs'],
  ['TOOL_INVOCATIONS', '/admin/tools/invocations'],
  ['CONFIG_TIMEZONE', '/admin/config/timezone'],
  ['CONFIG', '/admin/config'],
  ['ACCESS_KEYS', '/admin/admin-api-keys'],
  ['KEYS', '/admin/keys'],
  ['SHARED_KEYS', '/admin/shared-keys'],
  ['TOOLS', '/admin/tools'],
  ['PLAYGROUND', '/admin/playground'],
  ['SIMULATOR', '/admin/simulator'],
  ['WITHDRAWALS', '/admin/withdrawals'],
  ['NFT_MINTS', '/admin/nft-mints'],
];
export const ALL_FLAGS = [
  'CINATOKEN_WEB_PUBLIC_ENABLED', 'CINATOKEN_WEB_ACCOUNT_ENABLED',
  ...ADMIN_FLAGS_AND_PAGES.map(([name]) => `CINATOKEN_WEB_ADMIN_${name}_ENABLED`),
];
