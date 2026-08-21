-- User portal: shared-key marketplace, seller earnings, on-chain withdrawals, CinaBadge mints.
-- Note: MySQL 8 does not support ADD COLUMN IF NOT EXISTS; runs exactly once via schema_migrations.

ALTER TABLE providers ADD COLUMN shared_channel_type VARCHAR(64) NULL;

CREATE TABLE IF NOT EXISTS portal_sessions (
	token_hash VARCHAR(64) PRIMARY KEY,
	subject VARCHAR(255) NOT NULL,
	email VARCHAR(512) NOT NULL,
	created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	expires_at TIMESTAMP(6) NOT NULL,
	INDEX idx_portal_sessions_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shared_keys (
	id VARCHAR(128) PRIMARY KEY,
	seller_user_id VARCHAR(512) NOT NULL,
	channel_type VARCHAR(64) NOT NULL,
	api_key TEXT NOT NULL,
	key_fingerprint VARCHAR(128) NOT NULL,
	label VARCHAR(512),
	status VARCHAR(32) NOT NULL DEFAULT 'validating',
	seller_priority INT NOT NULL DEFAULT 0,
	weight INT NOT NULL DEFAULT 1,
	input_price DECIMAL(18,6) NOT NULL DEFAULT 0,
	output_price DECIMAL(18,6) NOT NULL DEFAULT 0,
	cache_read_price DECIMAL(18,6) NULL,
	cache_write_price DECIMAL(18,6) NULL,
	validated_at TIMESTAMP(6) NULL,
	last_used_at TIMESTAMP(6) NULL,
	last_failure_at TIMESTAMP(6) NULL,
	failure_reason TEXT NULL,
	served_input_tokens BIGINT NOT NULL DEFAULT 0,
	served_output_tokens BIGINT NOT NULL DEFAULT 0,
	earned_total DECIMAL(18,6) NOT NULL DEFAULT 0,
	created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	UNIQUE KEY uk_shared_keys_seller_fingerprint (seller_user_id, key_fingerprint),
	KEY idx_shared_keys_channel_status (channel_type, status),
	CONSTRAINT fk_shared_keys_user FOREIGN KEY (seller_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shared_key_earnings (
	id VARCHAR(128) PRIMARY KEY,
	request_log_id VARCHAR(128) NOT NULL,
	shared_key_id VARCHAR(128) NOT NULL,
	seller_user_id VARCHAR(512) NOT NULL,
	input_tokens INT NOT NULL DEFAULT 0,
	output_tokens INT NOT NULL DEFAULT 0,
	cache_read_tokens INT NOT NULL DEFAULT 0,
	cache_write_tokens INT NOT NULL DEFAULT 0,
	gross_amount DECIMAL(18,6) NOT NULL DEFAULT 0,
	platform_fee DECIMAL(18,6) NOT NULL DEFAULT 0,
	net_amount DECIMAL(18,6) NOT NULL DEFAULT 0,
	currency VARCHAR(16) NOT NULL DEFAULT 'USD',
	created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	UNIQUE KEY uk_shared_key_earnings_request_log (request_log_id),
	KEY idx_shared_key_earnings_seller_created (seller_user_id, created_at),
	CONSTRAINT fk_shared_key_earnings_log FOREIGN KEY (request_log_id) REFERENCES api_key_request_logs (id) ON DELETE CASCADE,
	CONSTRAINT fk_shared_key_earnings_key FOREIGN KEY (shared_key_id) REFERENCES shared_keys (id) ON DELETE CASCADE,
	CONSTRAINT fk_shared_key_earnings_user FOREIGN KEY (seller_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_earnings (
	user_id VARCHAR(512) PRIMARY KEY,
	balance DECIMAL(18,6) NOT NULL DEFAULT 0,
	locked_amount DECIMAL(18,6) NOT NULL DEFAULT 0,
	lifetime_earned DECIMAL(18,6) NOT NULL DEFAULT 0,
	lifetime_withdrawn DECIMAL(18,6) NOT NULL DEFAULT 0,
	contribution_value DECIMAL(18,6) NOT NULL DEFAULT 0,
	wallet_address VARCHAR(128) NULL,
	wallet_verified_at TIMESTAMP(6) NULL,
	highest_badge_tier INT NOT NULL DEFAULT 0,
	updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	CONSTRAINT fk_user_earnings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS withdrawals (
	id VARCHAR(128) PRIMARY KEY,
	user_id VARCHAR(512) NOT NULL,
	amount DECIMAL(18,6) NOT NULL,
	fee DECIMAL(18,6) NOT NULL DEFAULT 0,
	net_amount DECIMAL(18,6) NOT NULL,
	currency VARCHAR(16) NOT NULL DEFAULT 'USD',
	wallet_address VARCHAR(128) NOT NULL,
	status VARCHAR(32) NOT NULL DEFAULT 'requested',
	token_amount DECIMAL(18,6) NULL,
	tx_hash VARCHAR(128) NULL,
	chain_id INT NULL,
	failure_reason TEXT NULL,
	created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	confirmed_at TIMESTAMP(6) NULL,
	KEY idx_withdrawals_user_created (user_id, created_at),
	KEY idx_withdrawals_status (status),
	CONSTRAINT fk_withdrawals_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS nft_mints (
	id VARCHAR(128) PRIMARY KEY,
	user_id VARCHAR(512) NOT NULL,
	badge_token_id INT NOT NULL,
	tier_name VARCHAR(64) NOT NULL,
	wallet_address VARCHAR(128) NOT NULL,
	status VARCHAR(32) NOT NULL DEFAULT 'pending',
	tx_hash VARCHAR(128) NULL,
	chain_id INT NULL,
	value_snapshot DECIMAL(18,6) NOT NULL DEFAULT 0,
	failure_reason TEXT NULL,
	created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
	confirmed_at TIMESTAMP(6) NULL,
	UNIQUE KEY uk_nft_mints_user_badge (user_id, badge_token_id),
	KEY idx_nft_mints_user_created (user_id, created_at),
	CONSTRAINT fk_nft_mints_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
