// Offline artifact preparation only. No SSH, network, service or device APIs.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function replaceExactlyOnce(source, before, after) {
  if (!before || source.split(before).length !== 2) throw Error('baseline_fragment_not_unique');
  return source.replace(before, () => after);
}
export async function prepare({cloudSource, agentSource}) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'baseline.json'), 'utf8'));
  const sources = {};
  for (const [name, expected] of Object.entries(manifest.readOnlyProductionSources)) {
    const [owner, ...parts] = name.split('/');
    const base = owner === 'cloud' ? cloudSource : agentSource;
    if (!base) throw Error('explicit_source_paths_required');
    const value = await fs.readFile(path.join(base, ...parts));
    if (digest(value) !== expected) throw Error(`production_baseline_drift:${name}`);
    sources[name] = value.toString('utf8');
  }
  const staged = {...sources};
  for (const [target, fragment] of [
    ['agent/src/recovery-isolation.mjs', 'windows-agent/src/recovery-isolation.mjs'],
    ['agent/src/index.mjs', 'windows-agent/src/publish-device-snapshot.mjs'],
    ['cloud/public/app.js', 'public/recovery-console.js']
  ]) {
    const before = await fs.readFile(path.join(root, 'baseline', fragment), 'utf8');
    const after = await fs.readFile(path.join(root, 'candidate', fragment), 'utf8');
    staged[target] = replaceExactlyOnce(sources[target], before, after);
  }
  staged['cloud/public/index.html'] = replaceExactlyOnce(sources['cloud/public/index.html'],
    manifest.cacheReference.before, manifest.cacheReference.after);
  // Always a new local temporary directory, never an input/runtime path.
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-cloud-recovery-artifact-'));
  const hashes = {};
  for (const [name, source] of Object.entries(staged)) {
    const dest = path.join(output, name);
    await fs.mkdir(path.dirname(dest), {recursive: true});
    await fs.writeFile(dest, source, {flag: 'wx', mode: 0o600});
    if (name.endsWith('.mjs') || name.endsWith('.js')) {
      const check = spawnSync(process.execPath, ['--check', dest], {encoding: 'utf8'});
      if (check.status !== 0) throw Error(`prepared_syntax_failed:${name}`);
    }
    hashes[name] = digest(source);
  }
  const receipt = {releaseId: manifest.releaseId, status: 'offline_prepared_not_deployed',
    sourceHashes: manifest.readOnlyProductionSources, candidateHashes: hashes,
    runtimeFiles: Object.keys(staged), productionWrites: 0, deviceCommands: 0};
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag:'wx',mode:0o600});
  return {output, ...receipt};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--cloud-source' || args[2] !== '--agent-source') {
    throw Error('usage: node prepare.mjs --cloud-source LOCAL_READONLY_SNAPSHOT --agent-source LOCAL_READONLY_SNAPSHOT');
  }
  console.log(JSON.stringify(await prepare({cloudSource: path.resolve(args[1]), agentSource: path.resolve(args[3])}), null, 2));
}
