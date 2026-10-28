// Local combined regression only. Does not load .env, start an Agent or contact production.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (await fs.stat(path.join(root, '.env')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
  throw new Error('Run combined regression from an isolated checkout without a real .env file.');
}
const env = Object.fromEntries(['PATH', 'HOME', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
env.PYTHONDONTWRITEBYTECODE = '1';
env.DATABASE_URL = ''; env.REDIS_URL = ''; env.STORAGE_BACKEND = 'json';
const python = process.env.PYTHON || 'python3';
const nodeDirs = ['screen-client', 'server', 'scripts', 'windows-agent/src', 'server/xhs-batch',
  'scripts/ops', 'deploy/inventory-sync-compression', 'public', 'sdk/open_name_lookup',
  'examples/name-lookup', 'examples/name-lookup-api-key', 'tools/lookup-pool-live-tests',
  'ios-wda-lab/mjpeg-control-poc', 'experiments/lookup-icon-selector-20261023'];
async function run(command, args) {
  console.log(`\n[local regression] ${command} ${args.join(' ')}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`regression failed: ${code ?? signal}`)));
  });
}
const tests = [];
for (const dir of nodeDirs) for (const name of (await fs.readdir(path.join(root, dir))).sort()) {
  if (name.endsWith('.test.mjs')) tests.push(`${dir}/${name}`);
}
await run(process.execPath, ['--test', '--test-concurrency=2', ...tests]);
for (const dir of ['windows-agent/scripts', 'deploy/nginx-isolation', 'tools/windows-migration',
  'examples/name-lookup', 'examples/name-lookup-api-key', 'experiments/lookup-icon-selector-20261023']) {
  await run(python, ['-m', 'unittest', 'discover', '-s', dir, '-p', 'test_*.py']);
}
await run(python, ['-m', 'unittest', 'discover', '-s', 'windows-agent/scripts', '-p', '*_test.py']);
await run(python, ['-m', 'unittest', 'sdk.open_name_lookup.python_client_test']);
await run(python, ['-m', 'unittest', 'sdk.test_xhs_batch_client']);
await run(process.execPath, ['scripts/smoke-platform.mjs']);
console.log('\nLocal combined regression passed. PostgreSQL opt-in, Java/Go, native Windows and real devices require separate verification.');
