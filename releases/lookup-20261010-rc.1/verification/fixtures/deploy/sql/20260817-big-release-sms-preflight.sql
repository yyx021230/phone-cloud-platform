-- Read-only preflight for the big-release SMS migration.

with keyed as (
  select
    device_id,
    coalesce(nullif(btrim(data->>'messageKey'), ''), message_id) as message_key
  from phone_cloud_sms_messages
), grouped as (
  select device_id, message_key, count(*) as copies
  from keyed
  group by device_id, message_key
)
select
  (select count(*) from keyed) as total_rows,
  (select count(*) from grouped) as logical_rows,
  (select count(*) from grouped where copies > 1) as duplicate_groups,
  (select coalesce(sum(copies - 1), 0) from grouped where copies > 1) as duplicate_rows,
  (select count(*) from keyed where message_key is null or btrim(message_key) = '') as invalid_business_keys;
