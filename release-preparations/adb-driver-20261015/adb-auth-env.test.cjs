const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/adb-auth-env.cjs', 'utf8');
function run({platform = 'win32', prior = '', present = true} = {}) {
  const process = {platform, env: {ADB_VENDOR_KEYS: prior, SENTINEL: 'keep'}};
  const accesses = [];
  vm.runInNewContext(source, {process, require(name) {
    if (name === 'node:path') return {delimiter: ';'};
    if (name === 'node:fs') return {statSync(file) {accesses.push(file); return {isFile: () => present};}};
    throw Error('Unexpected dependency');
  }});
  return {process, accesses};
}
test('preserves prior configuration and loads existing identities without file reads/writes', () => {
  const r=run({prior: 'D:\\existing-key'});
  assert.equal(r.process.env.SENTINEL, 'keep');
  assert.equal(r.process.env.ADB_VENDOR_KEYS.split(';').length, 3);
  assert.equal(r.accesses.length, 2);
});
test('deduplicates existing key path', () => {
  const r=run({prior:'C:\\Users\\Administrator\\.android\\adbkey'});
  assert.equal(r.process.env.ADB_VENDOR_KEYS.split(';').length, 2);
});
test('fails closed on missing key or non-Windows', () => {
  assert.throws(() => run({present:false}));
  assert.throws(() => run({platform:'darwin'}));
});
