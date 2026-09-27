-- Bind gateway-owned functions to trusted schema resolution, independently of
-- the caller's search_path and Hyperdrive transaction-pool session resets.
-- pg_temp must be explicit and last: omission gives temporary relations an
-- implicit first position. Function bodies, ownership, ACLs and invoker/definer
-- modes remain unchanged. Run with the migrator, never the runtime role.

ALTER FUNCTION cinatoken_gateway.enforce_guardrail_assignment_api_key_workspace()
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;
ALTER FUNCTION cinatoken_gateway.enforce_request_log_workspace()
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;
ALTER FUNCTION cinatoken_gateway.enforce_workspace_budget_order()
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;
ALTER FUNCTION cinatoken_gateway.reject_model_endpoint_ledger_mutation()
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;

ALTER FUNCTION cinatoken_gateway.shared_key_earnings_credit_after_insert_fn()
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;
ALTER FUNCTION cinatoken_gateway.withdrawals_validate_lock_before_insert_fn()
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;
ALTER FUNCTION cinatoken_gateway.withdrawals_lock_after_insert_fn()
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;
ALTER FUNCTION cinatoken_gateway.withdrawals_confirm_after_status_update_fn()
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;
ALTER FUNCTION cinatoken_gateway.withdrawals_refund_after_status_update_fn()
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;
ALTER FUNCTION cinatoken_gateway.delete_provider_attempt_availability_before(timestamptz, integer)
  SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;
