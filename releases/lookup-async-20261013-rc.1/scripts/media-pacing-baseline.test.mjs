import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {baseline, verifyDropIn, verifyRepository, verifyLiveSnapshot, hasLocalMedia} from '../deploy/mediamtx-pacing/verify.mjs';

const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const dropIn = read('deploy/mediamtx-pacing/enable.conf.example');
const valid = () => ({pid: 1234, activeState: 'active', environment: {...baseline.environment},
  diskSha256: baseline.binarySha256, runningSha256: baseline.binarySha256, dropIn});

test('D-075 pins the approved custom binary and persistent all-viewer pacing', () => {
  verifyRepository();
  assert.equal(baseline.binarySha256, 'd3a9eab65555680f1a7efe6d1746f315e25c69059d49aff40a0a45d292feec35');
  assert.deepEqual(baseline.environment, {PHONECLOUD_VIEWER_PACING_BPS: '8000000', PHONECLOUD_VIEWER_PACING_GROUP_PACKETS: '2'});
  assert.match(baseline.scope, /all server-side pc\/ viewers/);
  assert.match(read('deploy/mediamtx-pacing/viewer-session.patch'), /strings.HasPrefix\(s.req.pathName, "pc\/"\)/);
});

test('approved disk, persistent config and running process all pass together', () => {
  assert.doesNotThrow(() => verifyLiveSnapshot(valid()));
});

test('original MediaMTX or a stale running executable blocks release', () => {
  const original = 'd6029e5926a4bf91a487b8ae44530f6f11e98d4ac6709a5f80d8b8b605980e9a';
  for (const key of ['diskSha256', 'runningSha256']) assert.throws(() => verifyLiveSnapshot({...valid(), [key]: original}), /binary drift/);
});

test('missing, disabled, changed-rate or changed-group runtime pacing blocks release', () => {
  for (const values of [{}, {PHONECLOUD_VIEWER_PACING_BPS:'0'}, {PHONECLOUD_VIEWER_PACING_BPS:'10000000'}, {PHONECLOUD_VIEWER_PACING_GROUP_PACKETS:'8'}]) {
    const sample=valid();sample.environment=Object.keys(values).length?{...sample.environment,...values}:{};
    assert.throws(() => verifyLiveSnapshot(sample), /effective/);
  }
});

test('missing persistent drop-in, overrides, duplicates and unsupported directives fail closed', () => {
  for (const text of ['', dropIn.replace('8000000','0'), dropIn+'\nEnvironment=PHONECLOUD_VIEWER_PACING_BPS=8000000',
    dropIn+'\nEnvironmentFile=/tmp/unreviewed', dropIn+'\n[Install]']) assert.throws(() => verifyDropIn(text));
});

test('drop-in section must precede assignments', () => {
  assert.throws(() => verifyDropIn('Environment=PHONECLOUD_VIEWER_PACING_BPS=8000000\n[Service]\nEnvironment=PHONECLOUD_VIEWER_PACING_GROUP_PACKETS=2'));
});

test('inactive/missing process cannot count as a verified live baseline', () => {
  for (const changes of [{activeState:'inactive'},{pid:0},{pid:NaN}]) assert.throws(() => verifyLiveSnapshot({...valid(),...changes}));
});

test('any surviving cohost media artifact triggers live checks, including a missing binary', () => {
  for (const marker of [baseline.binaryPath, baseline.unitPath, baseline.dropInPath]) assert.equal(hasLocalMedia(p => p===marker), true);
  assert.equal(hasLocalMedia(() => false), false);
});

test('legacy installer refuses before downloads, writes or service changes, even with old override variables', () => {
  const script=read('deploy/scripts/install-mediamtx.sh');
  assert.doesNotMatch(script, /^(?:curl|wget|tar|mkdir|chmod|install|systemctl)\s/m);
  const result=spawnSync('/bin/sh',[new URL('deploy/scripts/install-mediamtx.sh',root).pathname],
    {env:{...process.env,MEDIAMTX_VERSION:'1.18.2',SOURCE_DIR:'/does-not-exist'},encoding:'utf8',timeout:2000});
  assert.equal(result.status,2);assert.match(result.stderr,/BLOCKED.*D-075/);
});

test('normal compose deployment verifies before and after even when optional preflight is skipped', () => {
  const script=read('deploy/scripts/aliyun-docker-deploy.sh');
  const block=script.slice(script.indexOf('if [ "$START_STACK" = "true" ]'));
  const before=block.indexOf('verify.mjs" --deployment'),up=block.indexOf('docker compose up -d --build'),after=block.lastIndexOf('verify.mjs" --deployment');
  assert.ok(before>=0 && before<up && after>up);
  assert.match(read('deploy/scripts/preflight-production.sh'), /verify\.mjs" --deployment/);
});

test('repository-only check explicitly does not claim to have verified production', () => {
  const result=spawnSync(process.execPath,[new URL('deploy/mediamtx-pacing/verify.mjs',root).pathname,'--repository'],{encoding:'utf8',timeout:2000});
  assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).liveVerified,false);
});
