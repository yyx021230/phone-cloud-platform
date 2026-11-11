-- Separate CPS bridge journal. Apply only in an approved environment before
-- enabling the bridge. No changes to device/task/lookup tables or data.
BEGIN;
CREATE TABLE IF NOT EXISTS phone_cloud_cps_wecom (
    state_key text PRIMARY KEY,
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'
      AND coalesce(data->>'version','') = '2'
      AND coalesce(jsonb_typeof(data->'leads'),'') = 'array'
      AND coalesce(jsonb_typeof(data->'nonces'),'') = 'array'
      AND coalesce(jsonb_typeof(data->'recipients'),'') = 'array'
      AND coalesce(jsonb_typeof(data->'limits'),'') = 'array'),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
-- Rollback: stop the bridge first; keep this table for deduplication and callback
-- receipts. Do not DROP/TRUNCATE it or restore an older journal during rollback.
