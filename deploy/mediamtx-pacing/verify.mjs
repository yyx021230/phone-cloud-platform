// Read-only release guard. Never installs, repairs, restarts, or prints secrets.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const baseline = JSON.parse(fs.readFileSync(path.join(here, 'production-baseline.json'), 'utf8'));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function requireCheck(condition, message) { if (!condition) throw new Error(message); }

export function verifyDropIn(text, expected = baseline.environment) {
  // This owned drop-in deliberately supports only the two approved literals.
  // Reject extra directives/sections, duplicate assignments and override files.
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const approved = ['[Service]', ...Object.entries(expected).map(([k, v]) => `Environment=${k}=${v}`)];
  requireCheck(lines[0] === '[Service]' && lines.length === approved.length && approved.every(x => lines.filter(y => y === x).length === 1),
    'D-075 pacing drop-in must preserve the exact 8Mbps / 2-packet baseline');
}

export function verifyRepository() {
  requireCheck(baseline.decision === 'D-075' && /^[a-f0-9]{64}$/.test(baseline.binarySha256), 'Invalid media baseline manifest');
  requireCheck(baseline.environment.PHONECLOUD_VIEWER_PACING_BPS === '8000000' &&
    baseline.environment.PHONECLOUD_VIEWER_PACING_GROUP_PACKETS === '2' &&
    baseline.changesRequireExplicitUserApproval === true, 'Unapproved D-075 baseline change');
  verifyDropIn(fs.readFileSync(path.join(here, 'enable.conf.example'), 'utf8'));
}

export function verifyLiveSnapshot(snapshot, expected = baseline) {
  requireCheck(snapshot.activeState === 'active' && Number.isInteger(snapshot.pid) && snapshot.pid > 0,
    'Media service is not active; stop deployment and investigate');
  requireCheck(snapshot.diskSha256 === expected.binarySha256 && snapshot.runningSha256 === expected.binarySha256,
    'D-075 media binary drift: stock, stale or unapproved media executable');
  verifyDropIn(snapshot.dropIn, expected.environment);
  for (const [key, value] of Object.entries(expected.environment)) {
    requireCheck(snapshot.environment[key] === value, `D-075 effective ${key} does not match the approved baseline`);
  }
}

export function verifyLive() {
  requireCheck(process.platform === 'linux', 'Live verification must run on the Linux media host');
  const properties = execFileSync('systemctl', ['show', baseline.service, '-p', 'MainPID', '-p', 'ActiveState'],
    {encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']});
  const p = Object.fromEntries(properties.trim().split('\n').map(line => line.split('=')));
  const pid = Number(p.MainPID);
  requireCheck(Number.isInteger(pid) && pid > 0, 'Media service has no active PID');
  const proc = `/proc/${pid}`;
  const entries = fs.readFileSync(`${proc}/environ`, 'utf8').split('\0');
  const environment = {};
  for (const key of Object.keys(baseline.environment)) {
    const values = entries.filter(x => x.startsWith(key + '='));
    requireCheck(values.length === 1, `Missing or duplicate effective ${key}`);
    environment[key] = values[0].slice(key.length + 1);
  }
  verifyLiveSnapshot({pid, activeState: p.ActiveState, environment,
    diskSha256: digest(fs.readFileSync(baseline.binaryPath)),
    runningSha256: digest(fs.readFileSync(`${proc}/exe`)),
    dropIn: fs.readFileSync(baseline.dropInPath, 'utf8')});
  const pidAfter = Number(execFileSync('systemctl', ['show', baseline.service, '-p', 'MainPID', '--value'],
    {encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']}).trim());
  requireCheck(pidAfter === pid, 'Media PID changed during read-only verification; do not claim a stable baseline');
  return {decision: baseline.decision, verified: 'live', pid, binarySha256: baseline.binarySha256,
    bitsPerSecond: 8000000, packetsPerGroup: 2};
}

export function hasLocalMedia(exists = fs.existsSync) {
  return [baseline.binaryPath, baseline.unitPath, baseline.dropInPath].some(p => exists(p));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), mode = args[0];
    requireCheck(args.length === 1 && ['--repository', '--live', '--deployment'].includes(mode),
      'Use --repository, --live, or --deployment (local-media-host auto-detection)');
    verifyRepository();
    if (mode === '--live' || (mode === '--deployment' && hasLocalMedia())) console.log(JSON.stringify(verifyLive()));
    else console.log(JSON.stringify({decision: 'D-075', verified: 'repository-only', liveVerified: false,
      reason: mode === '--deployment' ? 'No media installation found on this host; verify the separate media host before release sign-off' : 'Local baseline files checked'}));
  } catch {
    // Never echo systemctl output, /proc environment, passwords or raw errors.
    console.error('D-075 baseline verification FAILED. Do not continue deployment or auto-repair. Check the approved binary hash, persistent drop-in and running pacing environment; live checks require permission to read the service process.');
    process.exitCode = 1;
  }
}
