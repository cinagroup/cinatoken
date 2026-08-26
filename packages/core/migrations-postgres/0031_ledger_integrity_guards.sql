-- 0031（Postgres）：shared_key_earnings.request_log_id 级联改 RESTRICT（审计 F8）
--
-- 0027 将 request_log_id 设为 ON DELETE CASCADE：未来任何针对 api_key_request_logs
-- 的保留期清理都会删除收益流水行，而触发器已入账的 user_earnings 余额保持不变
-- （无反向触发器）→ 余额 > 流水的静默漂移。改为 RESTRICT 使清理作业必须先处理
-- 收益流水，把决策显式化。
--
-- 注：D1/SQLite 无法 ALTER 外键（需 12 步重建表）；当前不存在任何日志清理作业
-- （风险为潜伏态），D1 侧待有清理需求时随表重建一并处理。

ALTER TABLE shared_key_earnings
  DROP CONSTRAINT IF EXISTS shared_key_earnings_request_log_id_fkey;

ALTER TABLE shared_key_earnings
  ADD CONSTRAINT shared_key_earnings_request_log_id_fkey
  FOREIGN KEY (request_log_id) REFERENCES api_key_request_logs(id) ON DELETE RESTRICT;
