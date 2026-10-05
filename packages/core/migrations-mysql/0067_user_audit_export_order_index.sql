-- Supports the global budget-audit list/export order and keyset cursor.
CREATE INDEX idx_user_audit_export_created_id
  ON user_audit_logs(created_at DESC, id DESC);
