import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const migration = await fs.readFile(new URL("../deploy/sql/20260817-big-release-sms-message-key.sql", import.meta.url), "utf8");
const rollback = await fs.readFile(new URL("../deploy/sql/20260817-big-release-sms-message-key-rollback.sql", import.meta.url), "utf8");
const preflight = await fs.readFile(new URL("../deploy/sql/20260817-big-release-sms-preflight.sql", import.meta.url), "utf8");

test("SMS migration archives duplicates before enforcing the business key", () => {
  const archiveAt = migration.indexOf("insert into phone_cloud_sms_messages_dedup_archive");
  const deleteAt = migration.indexOf("delete from phone_cloud_sms_messages");
  const uniqueAt = migration.indexOf("create unique index");
  assert.ok(archiveAt >= 0);
  assert.ok(deleteAt > archiveAt);
  assert.ok(uniqueAt > deleteAt);
  assert.match(migration, /partition by device_id, message_key/);
  assert.match(migration, /alter column message_key set not null/);
  assert.match(migration, /SMS migration left % duplicate business-key groups/);
});

test("SMS rollback restores only rows archived by the matching release", () => {
  assert.match(rollback, /drop index if exists phone_cloud_sms_device_message_key_uidx/);
  assert.match(rollback, /alter column message_key drop not null/);
  assert.match(rollback, /where archive_release = '20260817-big-release-v1'/);
  assert.match(rollback, /on conflict \(message_id\) do nothing/);
});

test("SMS preflight remains read-only and reports invalid business keys", () => {
  assert.doesNotMatch(preflight, /\b(insert|update|delete|alter|create|drop|truncate)\b/i);
  assert.match(preflight, /invalid_business_keys/);
  assert.match(preflight, /duplicate_rows/);
});
