import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import type { AdminPrincipal } from '@/lib/admin-principal';
const principal = { type: 'console', id: 'console:test', username: 'test', } as AdminPrincipal;
import { updateAdminSystemConfigService } from './dashboard-service';
const pricing = { v: 2, standard: 0.01, chargedFactor: 1.2, meteredFactor: 0.8 };
describe('admin REST pricing persistence', () => {
	for (const [key, provider, credentials] of [
		['WEB_SEARCH_CATALOG', 'bocha', { apiKey: 'test' }],
		['WEB_FETCH_CATALOG', 'firecrawl', { apiKey: 'test' }],
		['WEB_DEEP_SEARCH_CATALOG', 'firecrawl', { apiKey: 'test' }],
		['AI_DETECTION_CATALOG', 'tencent_tms', { secretId: 'test', secretKey: 'test', billingUnitChars: 3000 }],
	] as const) {
		it(`${key} persists only canonical factors and rejects invalid factors before writes`, async () => {
			const writes: string[] = [];
            const source = { [provider]: { ...credentials, pricing } };
            const initial = { [provider]: { ...credentials, pricing: { ...pricing, standard: 0.02 } } };
            const values = new Map<string, string>([[key, JSON.stringify(initial)], [key.replace('_CATALOG', '_ACTIVE'), provider]]);
            const revisions = new Map<string, string>();
            const repos = { systemConfig: {
                getConfigSnapshots: async (keys: string[]) => keys.map(key => ({ key, value: values.get(key) ?? null, revision: revisions.get(key) ?? (values.has(key) ? 'legacy' : null) })),
                listConfigGroupAudit: async () => [],
                applyConfigGroupIfRevisions: async (input: import('@octafuse/core').ConfigGroupApplyInput) => {
                    for (const write of input.writes) { writes.push(write.value); values.set(write.key, write.value); revisions.set(write.key, crypto.randomUUID()); }
                    return { outcome: 'applied', auditId: input.safeAudit.auditId, revisionVector: input.readSet.map(row => ({ key: row.key, revision: revisions.get(row.key) ?? row.revision })) };
                },
            } } as unknown as GatewayRepositories;
			await updateAdminSystemConfigService(repos, { key, value: JSON.stringify(source) }, principal);
			assert.deepEqual(JSON.parse(writes[0]), source);
			await assert.rejects(
				updateAdminSystemConfigService(repos, {
					key,
					value: JSON.stringify({
						[provider]: { ...credentials, pricing: { ...pricing, chargedFactor: -1 } },
					}),
				}, principal)
			);
			assert.equal(writes.length, 1);
		});
	}
});
