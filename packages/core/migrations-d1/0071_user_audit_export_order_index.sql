-- Global budget-audit list/export order. Normalize legacy SQL UTC seconds and
-- ISO UTC text exactly as the read query does, including its keyset cursor.
CREATE INDEX idx_user_audit_export_created_id
  ON user_audit_logs(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC, id DESC);
