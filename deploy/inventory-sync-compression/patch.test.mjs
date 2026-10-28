import assert from 'node:assert/strict';
import test from 'node:test';
import {gzipSync, gunzipSync} from 'node:zlib';
import {patchSite, marker, route} from './patch.mjs';

const original = `server {\n    location ^~ /webrtc/ {\n        proxy_pass http://127.0.0.1:8889/;\n    }\n    location / {\n        proxy_pass http://127.0.0.1:8787;\n        proxy_http_version 1.1;\n        proxy_set_header Authorization $http_authorization;\n        proxy_set_header Connection "upgrade";\n        proxy_read_timeout 7200s;\n    }\n}\n`;
test('only inserts an inventory location; all previous bytes and proxy behavior remain', () => {
  const result = patchSite(original);
  const start = result.indexOf(marker), end = result.indexOf('    location / {', start);
  assert.equal(result.slice(0, start) + result.slice(end), original);
  const proxy = original.match(/    location \/ \{\n([\s\S]*?)    \}/)[1];
  assert.ok(result.slice(start, end).includes(proxy));
  for (const directive of ['gzip_types application/json;', 'gzip_comp_level 1;', 'gzip_vary on;']) assert.ok(result.includes(directive));
});
test('anchored route excludes controls, tasks, heartbeat, queries in path and suffixes', () => {
  const re = new RegExp(route);
  assert.ok(re.test('/api/v1/windows-agents/win-123/devices/sync'));
  for (const value of ['/webrtc/pc/test', '/api/v1/devices', '/api/v1/windows-agents/heartbeat', '/api/v1/windows-agents/a/devices/sync/extra', '/api/v1/windows-agents/a/b/devices/sync', '/api/v1/user/automation/xhs-data-tasks']) assert.ok(!re.test(value));
});
test('rejects repeated install and unrecognized baseline instead of overwriting', () => {
  assert.throws(() => patchSite(patchSite(original)));
  assert.throws(() => patchSite(original.replace('8787', '9999')));
  assert.throws(() => patchSite(original + original));
});
test('compression preserves UTF-8, identity, occupancy, slot and null fields byte-for-byte', () => {
  const raw = Buffer.from(JSON.stringify({devices: Array.from({length: 141}, (_, i) => ({deviceId: `id-${i}`, deviceName: '测试手机', adb: {state: 'device'}, occupancy: i % 2 ? null : {lockType: 'xhs_data_collect', taskId: `task-${i}`}, xhsAccounts: [{appSlot: 'app1', enabled: true, xhsId: `xhs-${i}`}]}))}));
  const compressed = gzipSync(raw, {level: 1});
  assert.deepEqual(gunzipSync(compressed), raw);
  assert.ok(compressed.length < raw.length / 4);
});
