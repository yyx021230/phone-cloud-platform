import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSnapshot, escapeCopyText, writeSnapshotCopy } from '../server/snapshot-copy.mjs';
import { createRequire } from 'node:module';
const require = createRequire('/tmp/pc-oom-recovery-20261026/deps/package.json');
const { Client } = require('pg');
const stringify = value => JSON.stringify(value, (_k, v) => typeof v === 'string' ? v.replaceAll('\0', '') : v);
const connect = async () => {
  const client = new Client({ host: '127.0.0.1', port: 59626, user: process.env.USER, database: 'postgres' });
  await client.connect();
  await client.query('CREATE TEMP TABLE phone_cloud_state (state_key text PRIMARY KEY, data json NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  return client;
};

test('chunked serialization exactly preserves nested JSON, Unicode, NUL sanitization and omissions', () => {
  const snapshot = { items: ['中文😀', 'a\0b', '\\N\t\n\r"', undefined, NaN, null, { nested: [1, false] }], ignored: undefined, date: new Date('2026-10-26T00:00:00Z'), empty: [], value: false };
  const encoded = encodeSnapshot(snapshot, stringify, 12);
  assert.equal(encoded.chunks.join(''), stringify(snapshot));
  assert.equal(encoded.bytes, Buffer.byteLength(stringify(snapshot)));
  assert.ok(encoded.chunks.length > 3);
  snapshot.items[0] = 'changed';
  assert.equal(JSON.parse(encoded.chunks.join('')).items[0], '中文😀');
  assert.equal(escapeCopyText('a\\N\n\t\r'), 'a\\\\N\\n\\t\\r');
});

test('actual PostgreSQL COPY round trip preserves every value and updated_at', async () => {
  const client = await connect();
  try {
    const snapshot = { list: Array.from({ length: 1000 }, (_, i) => ({ i, text: `名字😀\\N\t\n\r\0${i}` })), stateVersion: 1 };
    const encoded = encodeSnapshot(snapshot, stringify, 160);
    await client.query('BEGIN');
    await client.query('TRUNCATE phone_cloud_state');
    await writeSnapshotCopy(client, 'a\\N\t\n', encoded);
    await client.query('COMMIT');
    const result = await client.query('SELECT * FROM phone_cloud_state');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].state_key, 'a\\N\t\n');
    assert.deepEqual(result.rows[0].data, JSON.parse(stringify(snapshot)));
    assert.ok(result.rows[0].updated_at instanceof Date);
  } finally { await client.end(); }
});

test('COPY failure rolls back TRUNCATE and retains previous snapshot; connection remains usable', async () => {
  const client = await connect();
  try {
    await client.query(`INSERT INTO phone_cloud_state VALUES ('old', '{"kept":true}', now())`);
    await client.query('BEGIN');
    await client.query('TRUNCATE phone_cloud_state');
    await assert.rejects(writeSnapshotCopy(client, 'bad', { chunks: ['{invalid json}'] }));
    await client.query('ROLLBACK');
    const result = await client.query('SELECT * FROM phone_cloud_state');
    assert.deepEqual(result.rows.map(x => [x.state_key, x.data]), [['old', { kept: true }]]);
    await client.query('BEGIN');
    await client.query('TRUNCATE phone_cloud_state');
    await writeSnapshotCopy(client, 'retry', encodeSnapshot({ success: true }, stringify));
    await client.query('COMMIT');
    assert.equal((await client.query('SELECT state_key FROM phone_cloud_state')).rows[0].state_key, 'retry');
  } finally { await client.end(); }
});
