-- Phone Cloud structured storage preparation.
-- This file is additive and non-destructive. The application still supports the
-- snapshot state during the migration window.

create table if not exists phone_cloud_agents (
  agent_id text primary key,
  agent_name text not null default '',
  token_hash text not null default '',
  token_prefix text not null default '',
  scopes jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  last_ip text not null default '',
  health jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists phone_cloud_devices (
  device_id text primary key,
  device_name text not null default '',
  listing_status text not null default 'pending',
  lease_agent_id text not null default '',
  adb_serial text not null default '',
  adb_state text not null default '',
  manufacturer text not null default '',
  brand text not null default '',
  model text not null default '',
  android_version text not null default '',
  automation jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists phone_cloud_devices_listing_idx on phone_cloud_devices (listing_status);
create index if not exists phone_cloud_devices_adb_serial_idx on phone_cloud_devices (adb_serial);

create table if not exists phone_cloud_device_sims (
  device_id text not null references phone_cloud_devices(device_id) on delete cascade,
  slot_index integer not null,
  subscription_id integer,
  carrier_name text not null default '',
  phone_number text not null default '',
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (device_id, slot_index)
);

create table if not exists phone_cloud_account_slots (
  device_id text not null references phone_cloud_devices(device_id) on delete cascade,
  platform text not null default 'xhs',
  app_slot text not null,
  label text not null default '',
  account_name text not null default '',
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (device_id, platform, app_slot)
);

create table if not exists phone_cloud_sms_messages (
  message_id text primary key,
  device_id text not null references phone_cloud_devices(device_id) on delete cascade,
  message_key text not null,
  sms_id text not null default '',
  box text not null default 'unknown',
  address text not null default '',
  phone_number text not null default '',
  body text not null default '',
  code text not null default '',
  platform text not null default '',
  message_at timestamptz not null,
  subscription_id integer,
  slot_index integer,
  source text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, message_key)
);

create index if not exists phone_cloud_sms_device_time_idx on phone_cloud_sms_messages (device_id, message_at desc);
create index if not exists phone_cloud_sms_phone_time_idx on phone_cloud_sms_messages (phone_number, message_at desc);

create table if not exists phone_cloud_sms_orders (
  order_id text primary key,
  user_id text not null default '',
  client_id text not null default '',
  device_id text not null default '',
  phone_number text not null default '',
  slot_index integer,
  subscription_id integer,
  platform text not null default '',
  status text not null default 'waiting',
  matched_message_id text,
  code text not null default '',
  started_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists phone_cloud_sms_orders_user_status_idx on phone_cloud_sms_orders (user_id, status, created_at desc);
create index if not exists phone_cloud_sms_orders_device_status_idx on phone_cloud_sms_orders (device_id, status, created_at desc);

create table if not exists phone_cloud_xhs_tasks (
  task_id text primary key,
  user_id text not null default '',
  device_id text not null default '',
  agent_id text not null default '',
  adb_serial text not null default '',
  app_slot text not null default 'app1',
  account_name text not null default '',
  status text not null default 'queued',
  execution_mode text not null default 'windows_appium',
  windows_task_id text not null default '',
  lock_id text not null default '',
  stalled_at timestamptz,
  recoverable boolean not null default true,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists phone_cloud_xhs_tasks_device_status_idx on phone_cloud_xhs_tasks (device_id, status, created_at desc);
create index if not exists phone_cloud_xhs_tasks_user_status_idx on phone_cloud_xhs_tasks (user_id, status, created_at desc);

create table if not exists phone_cloud_windows_tasks (
  task_id text primary key,
  agent_id text not null default '',
  adb_serial text not null default '',
  device_id text not null default '',
  type text not null default '',
  status text not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  stalled_at timestamptz,
  recoverable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists phone_cloud_windows_tasks_agent_status_idx on phone_cloud_windows_tasks (agent_id, status, created_at);

create table if not exists phone_cloud_device_locks (
  lock_id text primary key,
  lock_type text not null default 'xhs_qr',
  device_id text not null default '',
  app_slot text not null default '',
  owner_user_id text not null default '',
  task_id text not null default '',
  status text not null default 'active',
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists phone_cloud_device_locks_active_idx on phone_cloud_device_locks (device_id, status, app_slot);

create table if not exists phone_cloud_task_events (
  event_id text primary key,
  task_id text not null,
  task_kind text not null,
  phase text not null default 'log',
  level text not null default 'info',
  message text not null default '',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists phone_cloud_task_events_task_time_idx on phone_cloud_task_events (task_id, created_at desc);

create table if not exists phone_cloud_audit_events (
  audit_id text primary key,
  action text not null,
  actor jsonb not null default '{}'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists phone_cloud_audit_events_time_idx on phone_cloud_audit_events (created_at desc);
