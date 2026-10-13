-- Additive migration. Apply explicitly to an isolated database first.
-- Keep this table on application rollback; it contains requests and leases.
BEGIN;
CREATE TABLE IF NOT EXISTS phone_cloud_managed_lookup (
  state_key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(data) = 'object')
);
CREATE TABLE IF NOT EXISTS phone_cloud_managed_lookup_results (
  state_key text NOT NULL,
  lookup_id text NOT NULL,
  client_id text NOT NULL,
  idempotency_key text NOT NULL,
  completed_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(state_key, lookup_id),
  UNIQUE (state_key, client_id, idempotency_key)
);
COMMIT;
