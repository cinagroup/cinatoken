-- 0066: persist the route-selective settlement basis used by Gateway Key
-- limits. The D1 admission trigger authorizes this basis only while the
-- authenticated Gateway Key explicitly includes BYOK in its limit.

ALTER TABLE guardrail_budget_reservations
  ADD COLUMN settlement_basis TEXT NOT NULL DEFAULT 'charged'
  CHECK (settlement_basis IN ('charged', 'gateway_key_route'));

DROP TRIGGER trg_guardrail_budget_reservation_capacity;

CREATE TRIGGER trg_guardrail_budget_reservation_capacity
BEFORE INSERT ON guardrail_budget_reservations
BEGIN
  SELECT (CASE
    WHEN NEW.settlement_basis = 'gateway_key_route'
      AND substr(NEW.assignment_id, 1, 18) <> 'gateway-key-limit:'
      THEN RAISE(ABORT, 'invalid_guardrail_budget_settlement_basis')
    WHEN substr(NEW.assignment_id, 1, 18) = 'gateway-key-limit:' AND NOT EXISTS (
      SELECT 1 FROM api_keys key
      WHERE NEW.assignment_id = 'gateway-key-limit:' || NEW.scope_id
        AND NEW.guardrail_id = NEW.assignment_id
        AND NEW.scope_type = 'api_key'
        AND key.id = NEW.scope_id
        AND key.workspace_id = NEW.workspace_id
        AND key.status = 'active'
        AND (key.expires_at IS NULL OR datetime(key.expires_at) > datetime(NEW.created_at))
        AND key.limit_micros IS NOT NULL
        AND key.limit_micros = NEW.limit_micros
        AND key.limit_epoch + 1 = NEW.guardrail_version
        AND COALESCE(key.limit_reset, 'lifetime') = NEW.period
        AND (
          NEW.settlement_basis = 'charged'
          OR key.include_byok_in_limit = 1
        )
    ) THEN RAISE(ABORT, 'gateway_key_limit_stale')
    WHEN substr(NEW.assignment_id, 1, 17) = 'workspace-budget:' AND NOT EXISTS (
      SELECT 1 FROM workspace_budgets budget
      JOIN workspaces workspace ON workspace.id = budget.workspace_id
      WHERE NEW.assignment_id = 'workspace-budget:' || budget.id
        AND NEW.guardrail_id = NEW.assignment_id
        AND NEW.scope_type = 'workspace'
        AND NEW.scope_id = NEW.workspace_id
        AND budget.workspace_id = NEW.workspace_id
        AND budget.limit_micros = NEW.limit_micros
        AND budget.config_epoch + 1 = NEW.guardrail_version
        AND budget.reset_interval = NEW.period
        AND workspace.status = 'active'
    ) THEN RAISE(ABORT, 'workspace_budget_stale')
  END);

  INSERT OR IGNORE INTO guardrail_budget_windows (
    workspace_id, scope_type, scope_id, period, period_start, period_end,
    unreserved_micros, settled_micros, reserved_micros,
    seed_request_id, seeded_at, updated_at
  ) VALUES (
    NEW.workspace_id, NEW.scope_type, NEW.scope_id, NEW.period,
    NEW.period_start, NEW.period_end, 0, 0, 0,
    NEW.request_id, NEW.created_at, NEW.created_at
  );

  UPDATE guardrail_budget_windows
  SET unreserved_micros = COALESCE((
          SELECT SUM(COALESCE(
            log.budget_charged_micros,
            CAST(ROUND(MAX(log.charged_cost, 0) * 1000000) AS INTEGER)
          ))
          FROM api_key_request_logs log
          WHERE COALESCE(log.budget_accounted_at, log.created_at) >= NEW.period_start
            AND COALESCE(log.budget_accounted_at, log.created_at) < NEW.period_end
            AND log.workspace_id = NEW.workspace_id
            AND (
              (NEW.scope_type = 'user' AND log.user_id = NEW.scope_id) OR
              (NEW.scope_type = 'api_key' AND log.api_key_id = NEW.scope_id) OR
              (NEW.scope_type = 'workspace' AND NEW.scope_id = NEW.workspace_id)
            )
            AND NOT EXISTS (
              SELECT 1 FROM guardrail_budget_reservations reservation
              WHERE reservation.request_id = log.id
                AND reservation.workspace_id = NEW.workspace_id
                AND reservation.scope_type = NEW.scope_type
                AND reservation.scope_id = NEW.scope_id
                AND reservation.period = NEW.period
                AND reservation.period_start = NEW.period_start
                AND reservation.state IN ('reserved', 'dispatched', 'settled', 'expired')
            )
        ), 0),
      period_end = NEW.period_end,
      updated_at = NEW.created_at
  WHERE workspace_id = NEW.workspace_id
    AND scope_type = NEW.scope_type
    AND scope_id = NEW.scope_id
    AND period = NEW.period
    AND period_start = NEW.period_start
    AND seed_request_id = NEW.request_id;

  SELECT (CASE
    WHEN substr(NEW.assignment_id, 1, 18) = 'gateway-key-limit:' AND (
      SELECT unreserved_micros + settled_micros + reserved_micros + NEW.reserved_micros
      FROM guardrail_budget_windows
      WHERE workspace_id = NEW.workspace_id AND scope_type = NEW.scope_type
        AND scope_id = NEW.scope_id AND period = NEW.period AND period_start = NEW.period_start
    ) > NEW.limit_micros THEN RAISE(ABORT, 'gateway_key_limit_exceeded')
    WHEN substr(NEW.assignment_id, 1, 17) = 'workspace-budget:' AND (
      SELECT unreserved_micros + settled_micros + reserved_micros + NEW.reserved_micros
      FROM guardrail_budget_windows
      WHERE workspace_id = NEW.workspace_id AND scope_type = NEW.scope_type
        AND scope_id = NEW.scope_id AND period = NEW.period AND period_start = NEW.period_start
    ) > NEW.limit_micros THEN RAISE(ABORT, 'workspace_budget_exceeded')
    WHEN (
      SELECT unreserved_micros + settled_micros + reserved_micros + NEW.reserved_micros
      FROM guardrail_budget_windows
      WHERE workspace_id = NEW.workspace_id AND scope_type = NEW.scope_type
        AND scope_id = NEW.scope_id AND period = NEW.period AND period_start = NEW.period_start
    ) > NEW.limit_micros THEN RAISE(ABORT, 'guardrail_budget_exceeded')
  END);

  UPDATE guardrail_budget_windows
  SET reserved_micros = reserved_micros + NEW.reserved_micros,
      seed_request_id = NULL,
      updated_at = NEW.created_at
  WHERE workspace_id = NEW.workspace_id
    AND scope_type = NEW.scope_type
    AND scope_id = NEW.scope_id
    AND period = NEW.period
    AND period_start = NEW.period_start;
END;
