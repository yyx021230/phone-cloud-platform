-- Additive migration. Run explicitly before enabling the batch service.
-- Rollback stops the service and retains these tables/results.
CREATE TABLE IF NOT EXISTS phone_cloud_xhs_batch_records (
  record_key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS phone_cloud_xhs_batch_nonces (
  client_id text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (client_id, nonce)
);
CREATE INDEX IF NOT EXISTS phone_cloud_xhs_batch_owner_status
  ON phone_cloud_xhs_batch_records ((data->>'clientId'), (data->>'status'), (data->>'createdAt'));
CREATE INDEX IF NOT EXISTS phone_cloud_xhs_batch_nonce_expiry
  ON phone_cloud_xhs_batch_nonces (expires_at);
