BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
ALTER TABLE phone_cloud_state ALTER COLUMN data TYPE json USING data::json;
COMMIT;
