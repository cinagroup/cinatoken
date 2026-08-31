import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { GuardrailBudgetReservationRow } from '../guardrail-budget-types';
import type { GuardrailBudgetsRepository } from '../../storage/gateway-repository-interfaces';
import type { D1DatabaseClient } from '../../storage/database-client';
import {
	existingGuardrailReservationReplay,
	sortedGuardrailBudgetIntents,
	validateGuardrailBudgetReservationParams,
} from '../guardrail-budget-repository-utils';

async function listByRequest(client: D1DatabaseClient, requestId: string): Promise<GuardrailBudgetReservationRow[]> {
	return (await client.raw.prepare(`SELECT * FROM guardrail_budget_reservations WHERE request_id = ? ORDER BY assignment_id`).bind(requestId).all<GuardrailBudgetReservationRow>()).results ?? [];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createD1GuardrailBudgetsRepository(client: D1DatabaseClient): GuardrailBudgetsRepository {
	return {
		async reserveMany(params) {
			const invalid = validateGuardrailBudgetReservationParams(params);
			if (invalid) return { status: 'conflict', message: invalid };
			const replay = existingGuardrailReservationReplay(await listByRequest(client, params.requestId), params);
			if (replay === 'idempotent') return { status: 'idempotent', reservationCount: params.intents.length };
			if (replay === 'conflict') return { status: 'conflict', message: 'request id already has a different Guardrail budget reservation' };

			const statements: D1PreparedStatement[] = sortedGuardrailBudgetIntents(params.intents).map((intent) =>
				client.raw.prepare(`INSERT INTO guardrail_budget_reservations (
					id, workspace_id, request_id, assignment_id, guardrail_id, guardrail_version,
					scope_type, scope_id, period, period_start, period_end,
					limit_micros, reserved_micros, settled_micros, state,
					expires_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'reserved', ?, ?, ?)`)
					.bind(
						crypto.randomUUID(), intent.workspaceId, params.requestId, intent.assignmentId, intent.guardrailId,
						intent.guardrailVersion, intent.scopeType, intent.scopeId, intent.period,
						intent.periodStart, intent.periodEnd, intent.limitMicros, params.reservedMicros,
						params.expiresAtIso, params.nowIso, params.nowIso,
					),
			);
			try {
				await client.raw.batch(statements);
				return { status: 'reserved', reservationCount: statements.length };
			} catch (error) {
				const racedReplay = existingGuardrailReservationReplay(await listByRequest(client, params.requestId), params);
				if (racedReplay === 'idempotent') return { status: 'idempotent', reservationCount: params.intents.length };
				if (racedReplay === 'conflict') return { status: 'conflict', message: 'request id reservation payload mismatch' };
				const message = errorText(error);
				if (message.includes('gateway_key_limit_exceeded')) {
					const intent = params.intents.find((item) => item.assignmentId.startsWith('gateway-key-limit:'));
					return { status: 'blocked', assignmentId: intent?.assignmentId ?? null };
				}
				if (message.includes('workspace_budget_exceeded')) {
					const intent = params.intents.find((item) => item.assignmentId.startsWith('workspace-budget:'));
					return { status: 'blocked', assignmentId: intent?.assignmentId ?? null };
				}
				if (message.includes('guardrail_budget_exceeded')) return { status: 'blocked', assignmentId: null };
				if (message.includes('gateway_key_limit_stale')) {
					return { status: 'conflict', message: 'Gateway key limit configuration changed; retry the request' };
				}
				if (message.includes('workspace_budget_stale')) {
					return { status: 'conflict', message: 'Workspace budget configuration changed; retry the request' };
				}
				throw error;
			}
		},

		async markDispatched(requestId, nowIso, expiresAtIso) {
			const result = await client.raw.prepare(`UPDATE guardrail_budget_reservations
				SET state = 'dispatched', dispatched_at = ?, expires_at = ?, updated_at = ?
				WHERE request_id = ? AND state = 'reserved'
					AND NOT EXISTS (
						SELECT 1 FROM guardrail_budget_reservations AS other
						WHERE other.request_id = ? AND other.state <> 'reserved'
					)`)
				.bind(nowIso, expiresAtIso, nowIso, requestId, requestId).run();
			if ((result.meta.changes ?? 0) > 0) return true;
			const rows = await listByRequest(client, requestId);
			return rows.length > 0 && rows.every((row) => row.state === 'dispatched');
		},

		async releaseMany(requestId, nowIso, reason) {
			const result = await client.raw.prepare(`UPDATE guardrail_budget_reservations
				SET state = 'released', settled_micros = 0, terminal_at = ?, terminal_reason = ?, updated_at = ?
				WHERE request_id = ? AND state = 'reserved'`)
				.bind(nowIso, reason.slice(0, 128), nowIso, requestId).run();
			return result.meta.changes ?? 0;
		},

		async forfeitMany(requestId, nowIso, reason) {
			const result = await client.raw.prepare(`UPDATE guardrail_budget_reservations
				SET state = 'expired', settled_micros = reserved_micros, terminal_at = ?, terminal_reason = ?, updated_at = ?
				WHERE request_id = ? AND state IN ('reserved', 'dispatched')`)
				.bind(nowIso, reason.slice(0, 128), nowIso, requestId).run();
			return result.meta.changes ?? 0;
		},

		async expireBefore(nowIso, limit = 100) {
			const bounded = Math.max(1, Math.min(Math.trunc(limit), 1000));
			const candidates = (await client.raw.prepare(`SELECT id, state FROM guardrail_budget_reservations
				WHERE state IN ('reserved', 'dispatched') AND expires_at <= ? ORDER BY expires_at, id LIMIT ?`)
				.bind(nowIso, bounded).all<{ id: string; state: 'reserved' | 'dispatched' }>()).results ?? [];
			if (candidates.length === 0) return 0;
			const statements = candidates.map((row) => row.state === 'reserved'
				? client.raw.prepare(`UPDATE guardrail_budget_reservations SET state = 'released', settled_micros = 0, terminal_at = ?, terminal_reason = 'lease_expired_before_dispatch', updated_at = ? WHERE id = ? AND state = 'reserved'`).bind(nowIso, nowIso, row.id)
				: client.raw.prepare(`UPDATE guardrail_budget_reservations SET state = 'expired', settled_micros = reserved_micros, terminal_at = ?, terminal_reason = 'lease_expired_after_dispatch', updated_at = ? WHERE id = ? AND state = 'dispatched'`).bind(nowIso, nowIso, row.id));
			const results = await client.raw.batch(statements);
			return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
		},
	};
}
