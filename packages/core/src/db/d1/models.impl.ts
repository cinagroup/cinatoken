import {
	modelPricingScheduleUpdate,
	modelPricingScheduleChanged,
	modelPricingRouteAlignments,
	type ModelPricingRouteSnapshot,
} from '../model-pricing-alignment';
/**
 * D1：`models` / `model_tags`。
 */
import type { D1DatabaseClient } from '../../storage/database-client';
import type { ModelsRepository } from '../../storage/gateway-repository-interfaces';
import type { ModelWithRouteCountsRow } from '../../storage/repository-dtos';
import { MODEL_PATCH_COLS } from '../patch-allowlists';
import {
	assertModelPolicyExpected,
	modelPolicyPatch,
	modelPolicyTags,
	modelPolicyWriteMatched,
} from '../model-policy-conditional-write';

const MODEL_LIST_WITH_ROUTE_COUNTS_SQL = `SELECT m.id, m.display_name, m.vendor, m.context_window, m.max_tokens, m.pricing_profile,
				(SELECT json_group_array(mt.tag) FROM model_tags mt WHERE mt.model_id = m.id) AS tags,
				m.description, m.metadata, m.input_modalities, m.output_modalities, m.released_at, m.route_policy, m.created_at,
				(SELECT COUNT(*) FROM model_routes WHERE model_id = m.id) AS routes_count,
				(SELECT COUNT(*) FROM model_routes WHERE model_id = m.id AND status = 'active') AS active_routes_count
			 FROM models m ORDER BY m.id ASC`;

const MODEL_DETAIL_WITH_ROUTE_COUNTS_SQL = `SELECT m.id, m.display_name, m.vendor, m.context_window, m.max_tokens, m.pricing_profile,
					(SELECT json_group_array(mt.tag) FROM model_tags mt WHERE mt.model_id = m.id) AS tags,
					m.description, m.metadata, m.input_modalities, m.output_modalities, m.released_at, m.route_policy, m.created_at,
					(SELECT COUNT(*) FROM model_routes WHERE model_id = m.id) AS routes_count,
					(SELECT COUNT(*) FROM model_routes WHERE model_id = m.id AND status = 'active') AS active_routes_count
				 FROM models m WHERE m.id = ?`;

export function createD1ModelsRepository(db: D1DatabaseClient): ModelsRepository {
	const raw = db.raw;
	return {
		async listModelsWithRouteCounts(): Promise<ModelWithRouteCountsRow[]> {
			const rows = await raw.prepare(MODEL_LIST_WITH_ROUTE_COUNTS_SQL).all<ModelWithRouteCountsRow>();
			return rows.results ?? [];
		},

		async getModelDetailWithRouteCounts(id: string): Promise<ModelWithRouteCountsRow | null> {
			return raw.prepare(MODEL_DETAIL_WITH_ROUTE_COUNTS_SQL).bind(id).first<ModelWithRouteCountsRow>();
		},

		async insertModel(params: {
			id: string;
			displayName: unknown;
			vendor: string;
			contextWindow: unknown;
			maxTokens: unknown;
			pricingProfile?: unknown;
			description: unknown;
			metadata: unknown;
			inputModalities?: unknown;
			outputModalities?: unknown;
			releasedAt?: unknown;
		}): Promise<void> {
			await raw
				.prepare(
					`INSERT INTO models (id, display_name, vendor, context_window, max_tokens, pricing_profile, description, metadata, input_modalities, output_modalities, released_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					params.id,
					params.displayName ?? null,
					params.vendor,
					params.contextWindow ?? null,
					params.maxTokens,
					params.pricingProfile == null ? null : String(params.pricingProfile),
					params.description ?? null,
					params.metadata ?? null,
					params.inputModalities == null ? null : String(params.inputModalities),
					params.outputModalities == null ? null : String(params.outputModalities),
					params.releasedAt == null ? null : String(params.releasedAt),
				)
				.run();
		},

		async replaceModelTags(modelId: string, tags: string[]): Promise<void> {
			await raw.prepare('DELETE FROM model_tags WHERE model_id = ?').bind(modelId).run();
			for (const tag of tags) {
				const t = String(tag).trim();
				if (t) await raw.prepare('INSERT INTO model_tags (model_id, tag) VALUES (?, ?)').bind(modelId, t).run();
			}
		},

		async updateModelByPatch(id: string, rest: Record<string, unknown>): Promise<number> {
			const patch: string[] = [];
			const bindValues: unknown[] = [];
			for (const [key, value] of Object.entries(rest)) {
				if (key === 'id' || value === undefined) continue;
				if (!MODEL_PATCH_COLS.has(key)) continue;
				patch.push(`${key} = ?`);
				bindValues.push(value);
			}
			if (patch.length === 0) return 0;
			const result = await raw
				.prepare(`UPDATE models SET ${patch.join(', ')} WHERE id = ?`)
				.bind(...bindValues, id)
				.run();
			return result.meta.changes;
		},

		async updateModelWithPolicyPrecondition(id, rest, expectedRoutePolicy, tags): Promise<boolean> {
			assertModelPolicyExpected(expectedRoutePolicy);
			const patch = modelPolicyPatch(rest);
			let expected = 'id = ? COLLATE BINARY AND route_policy IS ? COLLATE BINARY';
			const expectedValues: unknown[] = [id, expectedRoutePolicy];
			const nextSchedule = modelPricingScheduleUpdate(rest);
			let alignment: ReturnType<typeof modelPricingRouteAlignments> = [];
			if (nextSchedule) {
				const model = await raw
					.prepare(
						'SELECT pricing_profile FROM models WHERE id = ? COLLATE BINARY AND route_policy IS ? COLLATE BINARY',
					)
					.bind(id, expectedRoutePolicy)
					.first<{ pricing_profile: string | null }>();
				if (!model) return false;
				if (modelPricingScheduleChanged(model.pricing_profile, nextSchedule)) {
					const snapshot = await raw
						.prepare('SELECT id, price_override FROM model_routes WHERE model_id = ? COLLATE BINARY ORDER BY id')
						.bind(id)
						.all<ModelPricingRouteSnapshot>();
					if (!snapshot.success) throw new Error('Invalid model pricing route snapshot');
					const rows = snapshot.results ?? [];
					alignment = modelPricingRouteAlignments(rows, nextSchedule);
					const readSet = JSON.stringify(rows);
					expected += ` AND pricing_profile IS ? COLLATE BINARY
                  AND (SELECT COUNT(*) FROM model_routes WHERE model_id = models.id COLLATE BINARY) = json_array_length(?)
                  AND NOT EXISTS (SELECT 1 FROM json_each(?) snapshot LEFT JOIN model_routes route
                    ON route.id = json_extract(snapshot.value, '$.id') COLLATE BINARY AND route.model_id = models.id COLLATE BINARY
                    WHERE route.id IS NULL OR route.price_override IS NOT json_extract(snapshot.value, '$.price_override') COLLATE BINARY)`;
					expectedValues.push(model.pricing_profile, readSet, readSet);
				}
			}
			const statements = [];
			const cleanTags = modelPolicyTags(tags);
			// All read-set checks run before the final policy UPDATE in one atomic D1 batch.
			if (cleanTags !== undefined) {
				statements.push(
					raw
						.prepare(
							`DELETE FROM model_tags WHERE model_id = ? COLLATE BINARY AND EXISTS (SELECT 1 FROM models WHERE ${expected})`,
						)
						.bind(id, ...expectedValues),
				);
				for (const tag of cleanTags)
					statements.push(
						raw
							.prepare(`INSERT INTO model_tags (model_id, tag) SELECT id, ? FROM models WHERE ${expected}`)
							.bind(tag, ...expectedValues),
					);
			}
			const set = patch.length ? patch.map(([key]) => `${key} = ?`).join(', ') : 'id = id';
			const modelWriteIndex = statements.length;
			statements.push(
				raw
					.prepare(`UPDATE models SET ${set} WHERE ${expected} RETURNING id`)
					.bind(...patch.map(([, value]) => value), ...expectedValues),
			);
			if (alignment.length) {
				const plan = JSON.stringify(alignment);
				// changes() is the immediately preceding model UPDATE in this atomic batch.
				statements.push(
					raw
						.prepare(
							`UPDATE model_routes SET price_override =
                (SELECT json_extract(value, '$.next') FROM json_each(?) WHERE json_extract(value, '$.id') = model_routes.id COLLATE BINARY)
                WHERE changes() = 1 AND model_id = ? COLLATE BINARY
                  AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
						)
						.bind(plan, id, plan),
				);
			}
			const results = await raw.batch<{ id: string }>(statements);
			if (results.length !== statements.length || results.some((result) => !result.success))
				throw new Error('Invalid conditional model batch acknowledgement');
			return modelPolicyWriteMatched(results[modelWriteIndex].results, id);
		},

		async deleteModelCascade(id: string): Promise<number> {
			await raw.prepare('DELETE FROM model_routes WHERE model_id = ?').bind(id).run();
			await raw.prepare('DELETE FROM model_tags WHERE model_id = ?').bind(id).run();
			const deleted = await raw.prepare('DELETE FROM models WHERE id = ?').bind(id).run();
			return deleted.meta.changes;
		},
	};
}
