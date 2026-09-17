-- Roll back the SMS business-key constraint and restore rows archived by the
-- matching big release. Run while the phone-cloud application is stopped.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '15min';
select pg_advisory_xact_lock(hashtext('phone-cloud-sms-message-key-v1'));

lock table phone_cloud_sms_messages in access exclusive mode;

drop index if exists phone_cloud_sms_device_message_key_uidx;

-- The previous application release does not insert message_key. Keep the
-- additive column for auditability, but restore its legacy nullable contract
-- before the old server is started.
alter table phone_cloud_sms_messages
  alter column message_key drop not null;

insert into phone_cloud_sms_messages (
  message_id,
  device_id,
  message_key,
  message_at,
  data,
  updated_at
)
select
  message_id,
  device_id,
  message_key,
  message_at,
  data,
  updated_at
from phone_cloud_sms_messages_dedup_archive
where archive_release = '20260817-big-release-v1'
on conflict (message_id) do nothing;

commit;
