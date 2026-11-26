import { drainNodeBackgroundWork } from '../runtime/schedule-background-work';
import { after } from 'node:test';
import {
	createD1StorageContext,
	computeRouteDataPolicySubjectFingerprintFromRows,
	getAccessibleWorkspaceForSubject,
	type ModelRow,
	type ModelRouteRow,
	type ProviderRow,
	type StorageContext,
} from '@octafuse/core';
import { createSqliteD1 } from './sqlite-d1';

/** Real tenant, admission, Guardrail and settlement storage for native route tests. */
export async function nativeRealtimeFixture(
	input: {
		models?: Record<string, Record<string, unknown>>;
		routes?: Record<string, unknown>[];
		apiKey?: Record<string, unknown>;
	},
	protocol: 'elevenlabs' | 'dashscope',
): Promise<StorageContext> {
	const db = createSqliteD1();
	after(async () => {
		await drainNodeBackgroundWork();
		db.sqlite.close();
	});
	const base = createD1StorageContext(db.binding),
		repos = base.repositories;
	db.sqlite.exec(
		"INSERT INTO users(id,email,budget_max,external_system,external_user_id) VALUES('user-1','u@example.com',100,'cinaauth','verified-user-1')",
	);
	await getAccessibleWorkspaceForSubject(base.client, {
		userId: 'user-1',
		subject: 'verified-user-1',
		workspaceId: 'personal:user-1',
	});
	db.sqlite.exec(
		"INSERT INTO api_keys(id,key,user_id,workspace_id) VALUES('key-1','sk-ok','user-1','personal:user-1')",
	);
	const provider = {
		id: protocol,
		name: protocol === 'elevenlabs' ? 'ElevenLabs' : 'DashScope',
		status: 'active',
		api_key: protocol === 'elevenlabs' ? 'el-secret' : 'secret',
		endpoints: JSON.stringify({
			[protocol]: {
				base:
					protocol === 'elevenlabs'
						? 'https://api.elevenlabs.io/v1'
						: 'https://dashscope.aliyuncs.com/api/v1',
			},
		}),
		description: null,
		created_at: new Date().toISOString(),
	} as ProviderRow;
	const rows = (input.routes ?? []).map((row) => ({ ...row, route_pool_id: null })) as ModelRouteRow[];
	const bindings = await Promise.all(
		rows.map(async (row) => ({
			id: `endpoint-${row.id}`,
			model_id: row.model_id,
			provider_id: row.provider_id,
			provider_slug: protocol,
			tag: 'test',
			endpoint_class: 'standard',
			region: null,
			context_length: 8192,
			max_prompt_tokens: null,
			max_completion_tokens: 1024,
			quantization: null,
			supported_parameters: '[]',
			pricing: '{"currency":"USD","prompt":"0","completion":"0"}',
			supports_implicit_caching: false,
			supports_voice_cloning: false,
			supports_tool_choice: '{"auto":true,"function":true,"none":true,"required":true}',
			audio_capabilities: JSON.stringify({
				v: 1,
				pricing_by_operation: {
					[row.upstream_operation ?? '*']: {
						currency: 'USD',
						meter: {
							kind: (row.upstream_operation ?? '').startsWith('audio.speech') ? 'characters' : 'duration',
							unit: (row.upstream_operation ?? '').startsWith('audio.speech')
								? 'unicode_code_point'
								: 'second',
							price: '0.0001',
							minimum_units: 0,
							increment_units: 1,
						},
					},
				},
			}),
			image_capabilities: '{}',
			evidence_url: 'https://evidence.example.invalid',
			verified_by: 'test',
			verified_at: new Date().toISOString(),
			expires_at: '2099-01-01T00:00:00.000Z',
			status: 'verified' as const,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			route_target_id: row.id,
			subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(row, provider),
		})),
	);
	if (input.apiKey && ('budget_max' in input.apiKey || 'budget_spent' in input.apiKey)) {
		db.sqlite
			.prepare('UPDATE users SET budget_max=?,budget_spent=? WHERE id=?')
			.run((input.apiKey.budget_max as number) ?? 100, (input.apiKey.budget_spent as number) ?? 0, 'user-1');
	}
	const key = await repos.apiKeys.getApiKeyWithUserByKey('sk-ok');
	return {
		...base,
		repositories: {
			...repos,
			apiKeys: {
				...repos.apiKeys,
				getApiKeyWithUserByKey: async () => ({ ...key, ...input.apiKey }) as typeof key,
			},
			modelRouting: {
				...repos.modelRouting,
				getModelById: async (id: string) => (input.models?.[id] as unknown as ModelRow) ?? null,
				resolveModelSurface: async () => null,
				getModelRoutesByModelId: async (id: string) => rows.filter((row) => row.model_id === id),
			},
			providers: {
				...repos.providers,
				getProvidersByIds: async () => [provider],
				getProviderById: async () => provider,
			},
			modelEndpoints: {
				...repos.modelEndpoints,
				listRuntimeBindingsByRouteTargetIds: async (ids: string[]) =>
					bindings.filter((row) => ids.includes(row.route_target_id)),
			},
		},
	};
}
