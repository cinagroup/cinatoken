-- User portal: shared-key marketplace, seller earnings, on-chain withdrawals, CinaBadge mints.
-- Note: SQLite does not support ADD COLUMN IF NOT EXISTS; runs exactly once via schema_migrations.

ALTER TABLE providers ADD COLUMN shared_channel_type TEXT;

CREATE TABLE IF NOT EXISTS portal_sessions (
  token_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_expires_at ON portal_sessions(expires_at);

CREATE TABLE IF NOT EXISTS shared_keys (
  id TEXT PRIMARY KEY,
  seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  api_key TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'validating',
  seller_priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  input_price REAL NOT NULL DEFAULT 0,
  output_price REAL NOT NULL DEFAULT 0,
  cache_read_price REAL,
  cache_write_price REAL,
  validated_at TEXT,
  last_used_at TEXT,
  last_failure_at TEXT,
  failure_reason TEXT,
  served_input_tokens INTEGER NOT NULL DEFAULT 0,
  served_output_tokens INTEGER NOT NULL DEFAULT 0,
  earned_total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (seller_user_id, key_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_shared_keys_channel_status
  ON shared_keys(channel_type, status);

CREATE TABLE IF NOT EXISTS shared_key_earnings (
  id TEXT PRIMARY KEY,
  request_log_id TEXT NOT NULL UNIQUE REFERENCES api_key_request_logs(id) ON DELETE CASCADE,
  shared_key_id TEXT NOT NULL REFERENCES shared_keys(id) ON DELETE CASCADE,
  seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  gross_amount REAL NOT NULL DEFAULT 0,
  platform_fee REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shared_key_earnings_seller_created
  ON shared_key_earnings(seller_user_id, created_at);

CREATE TABLE IF NOT EXISTS user_earnings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance REAL NOT NULL DEFAULT 0,
  locked_amount REAL NOT NULL DEFAULT 0,
  lifetime_earned REAL NOT NULL DEFAULT 0,
  lifetime_withdrawn REAL NOT NULL DEFAULT 0,
  contribution_value REAL NOT NULL DEFAULT 0,
  wallet_address TEXT,
  wallet_verified_at TEXT,
  highest_badge_tier INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  wallet_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  token_amount REAL,
  tx_hash TEXT,
  chain_id INTEGER,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user_created ON withdrawals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);

CREATE TABLE IF NOT EXISTS nft_mints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_token_id INTEGER NOT NULL,
  tier_name TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  chain_id INTEGER,
  value_snapshot REAL NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  UNIQUE (user_id, badge_token_id)
);

CREATE INDEX IF NOT EXISTS idx_nft_mints_user_created ON nft_mints(user_id, created_at);
