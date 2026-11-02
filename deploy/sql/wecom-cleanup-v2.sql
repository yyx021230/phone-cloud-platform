-- Unwired candidate. Apply only through a separately reviewed migration.
-- Protocol ledger only: never substitutes for the existing physical fence.
CREATE TABLE phone_cloud_wecom_cleanup_v2 (
  obligation_id text PRIMARY KEY,
  server_epoch text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 0 AND 2),
  host_operation_id text,
  close_operation_id text,
  protocol_state jsonb NOT NULL,
  CHECK (jsonb_typeof(protocol_state) = 'object'),
  CHECK ((protocol_state->>'version' = '2') IS TRUE),
  CHECK ((protocol_state->>'fence' = 'held') IS TRUE),
  CHECK ((protocol_state->>'revision' = revision::text) IS TRUE),
  CHECK ((protocol_state #>> '{binding,obligationId}' = obligation_id) IS TRUE),
  CHECK ((protocol_state #>> '{binding,serverEpoch}' = server_epoch) IS TRUE),
  CHECK ((protocol_state->>'hostOperationId') IS NOT DISTINCT FROM host_operation_id),
  CHECK ((protocol_state->>'closeOperationId') IS NOT DISTINCT FROM close_operation_id),
  CHECK (
    (revision = 0 AND host_operation_id IS NULL AND close_operation_id IS NULL) OR
    (revision = 1 AND host_operation_id IS NOT NULL AND close_operation_id IS NULL) OR
    (revision = 2 AND host_operation_id IS NOT NULL AND close_operation_id IS NOT NULL)
  ),
  CHECK (host_operation_id IS NULL OR close_operation_id IS NULL
         OR host_operation_id <> close_operation_id)
);
