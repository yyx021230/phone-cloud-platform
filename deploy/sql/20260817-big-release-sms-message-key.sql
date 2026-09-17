-- Big-release SMS business-key migration.
-- Run while the phone-cloud application is stopped. This migration archives
-- every removed duplicate before enforcing (device_id, message_key).

begin;
set local lock_timeout = '15s';
set local statement_timeout = '15min';
select pg_advisory_xact_lock(hashtext('phone-cloud-sms-message-key-v1'));

lock table phone_cloud_sms_messages in access exclusive mode;

alter table phone_cloud_sms_messages
  add column if not exists message_key text;

update phone_cloud_sms_messages
set message_key = coalesce(nullif(btrim(data->>'messageKey'), ''), message_id)
where message_key is null or btrim(message_key) = '';

create table if not exists phone_cloud_sms_messages_dedup_archive (
  archive_release text not null,
  archived_at timestamptz not null default now(),
  message_id text not null,
  device_id text not null,
  message_key text not null,
  message_at timestamptz,
  data jsonb not null,
  updated_at timestamptz not null,
  primary key (archive_release, message_id)
);

create temporary table phone_cloud_sms_duplicate_ids (
  message_id text primary key
) on commit drop;

insert into phone_cloud_sms_duplicate_ids (message_id)
select message_id
from (
  select
    message_id,
    row_number() over (
      partition by device_id, message_key
      order by
        case when coalesce(data->>'source', '') ilike '%notification%' then 1 else 0 end,
        updated_at desc,
        message_at desc nulls last,
        message_id
    ) as copy_rank
  from phone_cloud_sms_messages
) ranked
where copy_rank > 1;

insert into phone_cloud_sms_messages_dedup_archive (
  archive_release,
  message_id,
  device_id,
  message_key,
  message_at,
  data,
  updated_at
)
select
  '20260817-big-release-v1',
  sms.message_id,
  sms.device_id,
  sms.message_key,
  sms.message_at,
  sms.data,
  sms.updated_at
from phone_cloud_sms_messages sms
join phone_cloud_sms_duplicate_ids duplicate using (message_id)
on conflict (archive_release, message_id) do nothing;

delete from phone_cloud_sms_messages sms
using phone_cloud_sms_duplicate_ids duplicate
where sms.message_id = duplicate.message_id;

alter table phone_cloud_sms_messages
  alter column message_key set not null;

create unique index if not exists phone_cloud_sms_device_message_key_uidx
  on phone_cloud_sms_messages (device_id, message_key);

do $$
declare
  duplicate_groups bigint;
begin
  select count(*)
  into duplicate_groups
  from (
    select 1
    from phone_cloud_sms_messages
    group by device_id, message_key
    having count(*) > 1
  ) duplicates;
  if duplicate_groups <> 0 then
    raise exception 'SMS migration left % duplicate business-key groups', duplicate_groups;
  end if;
end $$;

commit;
