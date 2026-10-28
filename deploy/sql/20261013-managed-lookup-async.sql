-- Additive. Apply after20261013-managed-lookup.sql, retain on rollback.
BEGIN;
CREATE TABLE IF NOT EXISTS phone_cloud_managed_lookup_aliases (
 state_key text NOT NULL,
 client_id text NOT NULL,
 idempotency_key text NOT NULL,
 lookup_id text NOT NULL,
 fingerprint text NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(state_key,client_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS phone_cloud_managed_lookup_alias_target
 ON phone_cloud_managed_lookup_aliases(state_key,client_id,lookup_id);
CREATE INDEX IF NOT EXISTS phone_cloud_managed_lookup_recent_result
 ON phone_cloud_managed_lookup_results(state_key,client_id,(data->>'fingerprint'),completed_at DESC)
 WHERE data->>'status' IN ('succeeded','not_found');
COMMIT;
